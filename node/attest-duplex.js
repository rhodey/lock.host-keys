const net = require('net')
const crypto = require('crypto')
const attest = require('/runtime/attest.js')
const attestParse = require('/runtime/attest-parse.js')
const duplex = require('/runtime/attest-duplex.js')
const { timeout, writeStream, endStream } = duplex
const { PackrStream, UnpackrStream } = require('msgpackr')
const TPM = require('./attest-tpm.js')

const netTimeout = 5 * 1000

const noop = () => {}

// like /runtime/attest-duplex.js but also does TPM
async function client(url, testFn, log, userData=null) {
  let [timer, timedout] = timeout(netTimeout)
  const conn = new Promise((res, rej) => {
    timedout.catch((err) => {
      rej(new Error(`attest client timeout`))
      timedout = true
    })
    duplex.connect(url, testFn).then((ok) => {
      // server has attested
      const [encrypt, decrypt, attestData] = ok
      const pack = new PackrStream()
      const unpack = new UnpackrStream()

      const close = (err='') => {
        log(`warn attest client close`, url, err)
        endStream(encrypt)
        endStream(decrypt)
        endStream(pack)
        endStream(unpack)
      }

      if (timedout === true) { return close('timedout') }
      encrypt.on('error', close)
      decrypt.on('error', close)
      pack.on('error', close)
      unpack.on('error', close)

      encrypt.once('close', close)
      decrypt.once('close', close)
      pack.once('close', close)
      unpack.once('close', close)

      // client is inside Nitro Enclave
      const attestEnclave = (nonce) => {
        const pubKey = null
        nonce = Buffer.from(nonce, 'base64')
        attest(pubKey, nonce, userData).then((doc) => {
          doc = doc.toString('base64')
          writeStream(pack, { type: 'attest_doc', doc }).catch((err) => {
            log(`error attest client write attest_doc`, url, err)
            close()
          })
        }).catch((err) => {
          log(`error attest client attest enclave`, url, err)
          close()
        })
      }

      // client is outside Nitro Enclave - but has Nitro TPM
      const attestTpmNonce = (nonce) => {
        nonce = Buffer.from(nonce, 'base64')
        TPM.attestTpmNonce(nonce).then((info) => {
          writeStream(pack, { type: 'attest_tpm_nonce_ack', info }).catch((err) => {
            log(`error attest client write attest_tpm_nonce_ack`, url, err)
            close()
          })
        }).catch((err) => {
          log(`error attest client attest tpm nonce`, url, err)
          close()
        })
      }

      // client is outside Nitro Enclave - but has Nitro TPM
      const attestTpmChallenge = (challenge) => {
        challenge = Buffer.from(challenge, 'base64')
        TPM.attestTpmChallengeAck(challenge).then((result) => {
          result = result.toString('base64')
          writeStream(pack, { type: 'attest_tpm_challenge_ack', result }).catch((err) => {
            log(`error attest client write attest_tpm_challenge_ack`, url, err)
            close()
          })
        }).catch((err) => {
          log(`error attest client attest tpm challenge ack`, url, err)
          close()
        })
      }

      unpack.on('data', (msg) => {
        const nonceOk = typeof msg?.nonce === 'string'
        const challengeOk = typeof msg?.challenge === 'string'
        if (msg?.type === 'attest_nonce' && nonceOk) {
          attestEnclave(msg.nonce)
        } else if (msg?.type === 'attest_tpm_nonce' && nonceOk) {
          attestTpmNonce(msg.nonce)
        } else if (msg?.type === 'attest_tpm_challenge' && challengeOk) {
          attestTpmChallenge(msg.challenge)
        }
      })

      pack.pipe(encrypt)
      decrypt.pipe(unpack)

      res([pack, unpack, attestData])
    }).catch(rej)
  })
  conn.catch(noop).finally(() => clearTimeout(timer))
  return conn
}

function onClient(sock, testFn, log, cb, tpm=false, tpmEkPub=null) {
  // runtime has already attested us to client
  const pack = new PackrStream()
  const unpack = new UnpackrStream()
  const [timer, timedout] = timeout(netTimeout)

  const close = (err='') => {
    log(`warn attest server conn close`, err)
    writeStream(pack, { type: 'error', error: err }).catch(noop)
    endStream(sock)
    endStream(pack)
    endStream(unpack)
    clearTimeout(timer)
  }

  timedout.catch((err) => close(`attest server timeout`))

  sock.on('error', close)
  pack.on('error', close)
  unpack.on('error', close)

  sock.once('close', close)
  pack.once('close', close)
  unpack.once('close', close)

  // attest enclave
  const attestEnclaveAck = (doc) => {
    if (attested) { return }
    doc = Buffer.from(doc, 'base64')
    attestParse(doc).then((ok) => {
      const nonce2 = ok.nonce.toString('base64')
      if (nonce !== nonce2) { return close('nonce != nonce2') }
      testFn(ok.PCR, ok.userData).then((attestData) => {
        if (attested) { return }
        clearTimeout(timer)
        attested = true
        cb(null, [pack, unpack, attestData])
      }).catch((err) => close(err.message))
    }).catch((err) => close(`parse doc != ok - ${err.message}`))
  }

  // attest TPM
  let attestData = null
  const challenge = crypto.randomBytes(32)
  const attestTpmNonceAck = (info) => {
    if (attested) { return }
    const ourNonce = Buffer.from(nonce, 'base64')
    TPM.attestTpmNonceAck(ourNonce, info).then((PCR2) => {
      testFn(PCR2, null).then((attestData2) => {
        TPM.attestTpmChallenge(challenge, info, tpmEkPub).then((challenge2) => {
          if (attested) { return }
          attestData = attestData2
          challenge2 = challenge2.toString('base64')
          writeStream(pack, { type: 'attest_tpm_challenge', challenge: challenge2 }).catch((err) => {
            log(`error attest server write attest_tpm_challenge`, err)
            close()
          })
        }).catch((err) => close(`attest tpm challenge != ok - ${err.message}`))
      }).catch((err) => close(err.message))
    }).catch((err) => close(`attest tpm nonce ack != ok - ${err.message}`))
  }

  // attest TPM
  const attestTpmChallengeAck = (result) => {
    if (attested) { return }
    if (challenge.toString('base64') !== result) { return close('challenge != result') }
    clearTimeout(timer)
    attested = true
    cb(null, [pack, unpack, attestData])
  }

  // client has data for us
  sock.pipe(unpack).on('data', (msg) => {
    const enclaveOk = msg?.type === 'attest_doc' && typeof msg.doc === 'string'
    const tpmNonceAckOk = msg?.type === 'attest_tpm_nonce_ack' && typeof msg.info === 'object'
    const tpmChallengeAckOk = msg?.type === 'attest_tpm_challenge_ack' && typeof msg.result === 'string'

    if (tpm === false && enclaveOk) {
      attestEnclaveAck(msg.doc)
    } else if (tpm && tpmNonceAckOk) {
      attestTpmNonceAck(msg.info)
    } else if (tpm && tpmChallengeAckOk) {
      attestTpmChallengeAck(msg.result)
    }
  })

  // ask client to attest
  pack.pipe(sock)
  let attested = false
  const nonce = crypto.randomBytes(32).toString('base64')
  const type = tpm === false ? 'attest_nonce' : 'attest_tpm_nonce'
  writeStream(pack, { type, nonce }).catch((err) => {
    log(`error attest server write ${type}`, err)
    close()
  })
}

// both sides attest
function server(port, testFn, log, cb, tpm=false, tpmEkPub=null) {
  const client = (sock) => onClient(sock, testFn, log, cb, tpm, tpmEkPub)
  const server = net.createServer(client)
  return new Promise((res, rej) => {
    server.on('error', (err) => cb(new Error(`attest server error ${err.message}`)))
    server.on('error', (err) => rej(new Error(`attest server error ${err.message}`)))
    server.once('close', (err) => cb(new Error(`attest server close ${err.message}`)))
    server.once('close', (err) => rej(new Error(`attest server close ${err.message}`)))
    server.listen(port, '127.0.0.1', res)
  })
}

module.exports = {
  timeout, endStream,
  client, server
}
