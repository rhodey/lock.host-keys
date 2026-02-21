const fs = require('fs')
const exec = require('child_process').exec

const pcr_list = `sha256:0,1,2`
const files = `ek.ctx ek.pub ek.pub.tpmt ak.ctx ak.pub ak.name nonce.bin quote.out sig.out pcr.bin ek.pub.tss ak.name.xxd challenge.txt challenge.bin ses.ctx result.txt`
const isTest = process.env.PROD !== 'true'

function cmd(cmd, fix=0) {
  const env = {}
  if (process.env.TPM2TOOLS_TCTI) { env['TPM2TOOLS_TCTI'] = process.env.TPM2TOOLS_TCTI }
  // on khost abrmd is needed to be bypassed in one place
  if (fix && process.env.TPM2TOOLS_TCTI_FIX) { env['TPM2TOOLS_TCTI'] = process.env.TPM2TOOLS_TCTI_FIX }
  return new Promise((res, rej) => {
    exec(cmd, { cwd: '/tmp', env }, (error, stdout, stderr) => {
      if (error) { return rej(new Error(`${cmd} error ${error.code} ${stderr}`)) }
      res(stdout.trim())
    })
  })
}

// attest PCRs using nonce + EK + AK
async function attestTpmNonce(nonce) {
  await cmd(`tpm2_flushcontext -t -l -s && rm -f ${files}`)

  await cmd(`tpm2_createek -c ek.ctx -G rsa -u ek.pub`)
  await cmd(`tpm2_readpublic -c ek.ctx -f tpmt -o ek.pub.tpmt`)
  const ekTpmt = fs.readFileSync('/tmp/ek.pub.tpmt').toString('base64')

  await cmd(`tpm2_createak -C ek.ctx -c ak.ctx -G rsa -g sha256 -s rsassa -u ak.pub -n ak.name`)
  const ak = fs.readFileSync('/tmp/ak.pub').toString('base64')
  const akName = fs.readFileSync('/tmp/ak.name').toString('base64')

  fs.writeFileSync('/tmp/nonce.bin', nonce)
  await cmd(`tpm2_quote --key-context ak.ctx --pcr-list ${pcr_list} -g sha256 -q nonce.bin -m quote.out -s sig.out --pcr pcr.bin`)

  const quote = fs.readFileSync('/tmp/quote.out').toString('base64')
  const sig = fs.readFileSync('/tmp/sig.out').toString('base64')
  const pcr = fs.readFileSync('/tmp/pcr.bin').toString('base64')
  return { ekTpmt, ak, akName, quote, sig, pcr }
}

// test PCRs using nonce + AK
async function attestTpmNonceAck(ourNonce, theirInfo) {
  await cmd(`rm -f ${files}`)

  fs.writeFileSync('/tmp/nonce.bin', ourNonce)

  let { ak, quote, sig, pcr } = theirInfo
  ak = Buffer.from(ak, 'base64')
  quote = Buffer.from(quote, 'base64')
  sig = Buffer.from(sig, 'base64')
  pcr = Buffer.from(pcr, 'base64')

  fs.writeFileSync('/tmp/ak.pub', ak)
  fs.writeFileSync('/tmp/quote.out', quote)
  fs.writeFileSync('/tmp/sig.out', sig)
  fs.writeFileSync('/tmp/pcr.bin', pcr)

  pcr = await cmd(`tpm2_checkquote -q nonce.bin -u ak.pub -g sha256 -m quote.out -s sig.out -f pcr.bin`)
  const count = pcr_list.split(',').length
  pcr = pcr.split(`\n`).slice(2, 2 + count)
  pcr = pcr.map((str) => str.trim().split('0x')[1])

  const ok = pcr.every((pcr) => pcr.length === 64)
  if (!ok) { throw new Error('tpm2_checkquote error parse pcr') }
  return pcr
}

// encrypt challenge using EK + AK
async function attestTpmChallenge(plaintext, theirInfo, ourEkPub=null) {
  await cmd(`rm -f ${files}`)

  let { ekTpmt, akName } = theirInfo
  if (ourEkPub) { ekTpmt = ourEkPub }
  if (!isTest && !ourEkPub) { throw new Error('attest tpm challenge. test = false. ourEkPub = false') }
  ekTpmt = Buffer.from(ekTpmt, 'base64')
  fs.writeFileSync('/tmp/ek.pub.tpmt', ekTpmt)
  await cmd(`tpm2 print -t TPMT_PUBLIC -f tss ek.pub.tpmt > ek.pub.tss`)

  akName = Buffer.from(akName, 'base64')
  fs.writeFileSync('/tmp/ak.name', akName)
  await cmd(`xxd -p -c 256 ak.name > ak.name.xxd`)

  fs.writeFileSync('/tmp/challenge.txt', plaintext)
  await cmd(`tpm2_makecredential -u ek.pub.tss -n $(cat ak.name.xxd) -s challenge.txt -o challenge.bin`)
  return fs.readFileSync('/tmp/challenge.bin')
}

// decrypt challenge
async function attestTpmChallengeAck(encrypted) {
  await cmd(`rm -f ses.ctx challenge.bin result.txt`)

  await cmd(`tpm2_startauthsession -S ses.ctx --policy-session`)
  await cmd(`tpm2_policysecret -S ses.ctx -c e`)

  fs.writeFileSync('/tmp/challenge.bin', encrypted)
  await cmd(`tpm2_activatecredential -C ek.ctx -c ak.ctx -i challenge.bin -P session:ses.ctx -o result.txt`)
  return fs.readFileSync('/tmp/result.txt')
}

const NV_SIZE = 32
const NV_ADDR = '0x1500016'

// save secret in non volatile mem
async function writeTpmSecretP(secret) {
  await cmd(`tpm2_flushcontext ses2.ctx || true`, 1)
  await cmd(`rm -f secret.bin pcr2.bin ses2.ctx pcr2.policy`, 1)

  if (!Buffer.isBuffer(secret)) { throw new Error(`write tpm secret != buffer`) }
  if (secret.length !== NV_SIZE) { throw new Error(`write tpm secret ${secret.length} != ${NV_SIZE}`) }
  fs.writeFileSync('/tmp/secret.bin', secret)

  await cmd(`tpm2_pcrread ${pcr_list} -o pcr2.bin`, 1)
  await cmd(`tpm2_startauthsession -S ses2.ctx --policy-session`, 1)

  await cmd(`tpm2_policypcr -S ses2.ctx -l ${pcr_list} -f pcr2.bin -L pcr2.policy`, 1)
  await cmd(`tpm2_nvreadpublic ${NV_ADDR} && tpm2_nvundefine ${NV_ADDR} -C o || true`, 1)
  await cmd(`tpm2_nvdefine ${NV_ADDR} -C o -s ${NV_SIZE} -L pcr2.policy -a "policyread|policywrite"`, 1)
  await cmd(`tpm2_flushcontext ses2.ctx && rm ses2.ctx`, 1)

  await cmd(`tpm2_startauthsession -S ses2.ctx --policy-session`, 1)
  await cmd(`tpm2_policypcr -S ses2.ctx -l ${pcr_list}`, 1)
  await cmd(`tpm2_nvwrite ${NV_ADDR} -i secret.bin -P session:ses2.ctx`, 1)
  await cmd(`tpm2_flushcontext ses2.ctx && rm ses2.ctx`, 1)
}

// read secret
async function readTpmSecretP() {
  await cmd(`tpm2_flushcontext ses3.ctx || true`, 1)
  await cmd(`rm -f ses3.ctx secret2.bin`, 1)

  // tpm2_nvreadpublic does not have an error code which says no entry / not found
  // so we do this kind of thing to try to be sure we return null when it is correct to do
  await cmd(`tpm2_pcrread ${pcr_list}`, 1)
  try {
    await cmd(`tpm2_nvreadpublic ${NV_ADDR}`, 1)
  } catch (err) {
    if (err.message.includes('the handle is not correct')) { return null }
    throw err
  }

  await cmd(`tpm2_startauthsession -S ses3.ctx --policy-session`, 1)
  await cmd(`tpm2_policypcr -S ses3.ctx -l ${pcr_list}`, 1)
  await cmd(`tpm2_nvread ${NV_ADDR} -s ${NV_SIZE} -P session:ses3.ctx -o secret2.bin`, 1)

  const secret = fs.readFileSync('/tmp/secret2.bin')
  if (secret.length !== NV_SIZE) { throw new Error(`read tpm secret ${secret.length} != ${NV_SIZE}`) }
  return secret
}

// I secretly distrust TPMs a bit
// This is to minimize i/o
function cache() {
  let cache = undefined
  const writeTpmSecret = async (secret) => {
    if (Buffer.isBuffer(cache) && cache.equals(secret)) { return }
    return writeTpmSecretP(secret).then(() => {
      cache = secret
    })
  }
  const readTpmSecret = async () => {
    if (cache !== undefined) { return cache }
    const secret = await readTpmSecretP()
    cache = secret
    return cache
  }
  return { writeTpmSecret, readTpmSecret }
}

module.exports = {
  attestTpmNonce, attestTpmNonceAck,
  attestTpmChallenge, attestTpmChallengeAck,
  cache,
}
