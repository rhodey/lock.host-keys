const split = require('split')
const crypto = require('crypto')
const spawn = require('child_process').spawn
const { timeout, client } = require('./attest-duplex.js')
const TPM = require('./attest-tpm.js')

const tpmTimeout = 5_000
const netWriteTimeout = 5_000
const hostId = process.env.host_id
const sessionPath = process.env.LH_SESSION_PATH

const noop = () => {}
const sleep = (ms) => new Promise((res, rej) => setTimeout(res, ms))

function log(...args) {
  let from = 'khost'
  if (args[0] === 'host') {
    from = 'host'
    args = args.slice(1)
  }
  console.log.apply(null, [`${hostId} - ${from} -`, ...args])
}

function onError(err) {
  log('error', err)
  setTimeout(() => process.exit(1), 1_500)
}

function wrapPid(proc) {
  return new Promise((res, rej) => {
    proc.once('error', rej)
    if (proc.pid) { res(proc) }
    rej(new Error('no proc pid'))
  })
}

// exit on host exit
function wrapErrors(proc) {
  proc.once('exit', (code) => onError(new Error(`host exit ${code}`)))
  proc.on('error', (err) => onError(new Error(`host error ${err.message}`)))
  proc.stderr.on('error', (err) => onError(new Error(`host stderr error ${err.message}`)))
  proc.stdout.on('error', (err) => onError(new Error(`host stdout error ${err.message}`)))
  proc.stderr.once('end', () => onError(new Error('host stderr end')))
  proc.stdout.once('end', () => onError(new Error('host stdout end')))
  return proc
}

// spawn host as proc
async function startHost(args) {
  args = ['host.js', ...args]
  const stdio = ['pipe', 'pipe', 'pipe']
  const proc = spawn('node', args, { stdio, env: { ...process.env }, cwd: '/runtime' })
  return wrapPid(proc).then((proc) => {
    const hostLog = (line) => {
      line = line.trim()
      if (!line) { return }
      log('host', line)
    }
    proc.stderr.setEncoding('utf8')
    proc.stdout.setEncoding('utf8')
    proc.stderr.pipe(split()).on('data', hostLog)
    proc.stdout.pipe(split()).on('data', hostLog)
    return wrapErrors(proc)
  })
}

function writeStream(stream, data) {
  const [timer, timedout] = timeout(netWriteTimeout)
  const write = new Promise((res, rej) => {
    timedout.catch((err) => rej(new Error(`write stream timeout`)))
    stream.write(data, (err) => {
      if (!err) { return res() }
      rej(err)
    })
  })
  write.catch(noop).finally(() => clearTimeout(timer))
  return write
}

let tpmPrev = null

// connected and attested to key server
function tpmServer(txrx) {
  if (tpmPrev) { return onError('double tpm server') }
  tpmPrev = Promise.resolve(1)
  log('TPM server ready')
  const [tx, rx] = txrx

  const close = (err) => {
    log(`error tpm server conn close`, err)
    onError(err)
  }

  tx.on('error', close)
  rx.on('error', close)
  tx.once('close', () => close('close'))
  rx.once('close', () => close('close'))

  const cache = TPM.cache()

  const tpmRead = () => {
    const timer = setTimeout(() => onError(new Error(`tpm server read secret timeout`)), tpmTimeout)
    return cache.readTpmSecret().then((secret) => {
      clearTimeout(timer)
      secret = secret ? secret.toString('base64') : null
      writeStream(tx, { type: 'tpm_read_ack', secret }).catch((err) => {
        onError(new Error(`error tpm server write tpm_read_ack - ${err.message}`))
      })
    }).catch((err) => onError(new Error(`tpm server read tpm secret - ${err.message}`)))
  }

  const tpmWrite = (secret) => {
    const timer = setTimeout(() => onError(new Error(`tpm server write secret timeout`)), tpmTimeout)
    const secrett = Buffer.from(secret, 'base64')
    return cache.writeTpmSecret(secrett).then(() => {
      clearTimeout(timer)
      writeStream(tx, { type: 'tpm_write_ack', secret }).catch((err) => {
        onError(new Error(`error tpm server write tpm_write_ack - ${err.message}`))
      })
    }).catch((err) => onError(new Error(`tpm server write tpm secret - ${err.message}`)))
  }

  rx.on('data', (msg) => {
    const isRead = msg?.type === 'tpm_read'
    const isWrite = msg?.type === 'tpm_write' && typeof msg.secret === 'string'
    if (isRead) {
      tpmPrev = tpmPrev.then(tpmRead)
    } else if (isWrite) {
      tpmPrev = tpmPrev.then(() => tpmWrite(msg.secret))
    }
  })
}

// only talk to key servers
const testFn = async (PCR2, userData) => {
  PCR2 = crypto.createHash('sha256').update(PCR2.join('')).digest('hex')
  const APP_PCR = process.env.APP_PCR
  if (APP_PCR !== PCR2) { throw new Error('APP_PCR != PCR2') }
}

async function main() {
  log('main')
  await sleep(5_000)
  // connect into enclave
  const args = process.argv.slice(2)
  const [port1] = args.map((num) => parseInt(num))
  const url = `https://127.0.0.1:${port1}${sessionPath}`
  const txrx = await client(url, testFn, log)
  tpmServer(txrx)
}

log('boot')
const tcpPorts = process.argv.slice(2)

startHost(tcpPorts)
  .then(main)
  .catch(onError)
