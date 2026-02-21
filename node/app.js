const fs = require('fs/promises')
const crypto = require('crypto')
const yaml = require('js-yaml')
const { fromInstanceMetadata } = require('@aws-sdk/credential-providers')
const s3 = require('@aws-sdk/client-s3')
const ec2 = require('@aws-sdk/client-ec2')
const { RaftNode, FsLog, TimeoutLog } = require('tinyraftplus')
const { timeout, client, server } = require('./attest-duplex.js')
const attest = require('/runtime/attest.js')
const attestParse = require('/runtime/attest-parse.js')
const { pack, unpack } = require('msgpackr')
const appApp = require('./app-app.js')

const netConnTimeout = 5_000
const netWriteTimeout = 5_000

const logTimeout = 1_000
const logThrottle = 1_000
const raftLeaderTimeout = 120_000
const raftSecretTimeout = 120_000
const sessionPath = process.env.LH_SESSION_PATH

const hostId = process.env.host_id
const isTest = process.env.PROD !== 'true'
const LEADER = 'leader'

function log(...args) {
  console.log.apply(null, [`app -`, ...args])
}

function onError(err) {
  log('error', err)
  process.exit(1)
}

// todo: test on ec2
async function s3Get(key) {
  const client = process.env.S3_ENDPOINT ?
    new s3.S3Client({
      region: process.env.S3_REGION, endpoint: process.env.S3_ENDPOINT,
      credentials: { accessKeyId: process.env.S3_ACCESS, secretAccessKey: process.env.S3_SECRET },
      forcePathStyle: true
    }) : new s3.S3Client({ region: process.env.S3_REGION, credentials: fromInstanceMetadata({ timeout: 1000, maxRetries: 3 }) })
  const cmd = new s3.GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key })
  const controller = new AbortController()
  setTimeout(() => controller.abort(), netConnTimeout)
  const result = await client.send(cmd, { abortSignal: controller.signal }).catch((err) => {
    if (err instanceof s3.NoSuchKey) { return null }
    throw err
  })
  if (!result) { return null }
  const parts = []
  for await (const part of result.Body) { parts.push(part) }
  return Buffer.concat(parts)
}

// todo: test on ec2
async function ec2GetEkPub() {
  const client = new ec2.EC2Client({ region: selfEc2Region, credentials: fromInstanceMetadata({ timeout: 1000, maxRetries: 3 }) })
  const cmd = new GetInstanceTpmEkPubCommand({ InstanceId: selfEc2Id, KeyFormat: 'tpmt', KeyType: 'rsa-2048' })
  const result = await client.send(cmd)
  if (!result || typeof result.keyValue !== 'string') { throw new Error('ec2 result is missing keyValue') }
  return result.keyValue
}

const noop = () => {}

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

const clients = {}

// tx for tpm raft
function raftSend(to, msg) {
  to = `https://${to}:${port2 - 1}${sessionPath}`
  let next = clients[to]
  if (!next) {
    const userData = Buffer.from(amiPcr)
    next = clients[to] = client(to, testFnTpmRaft, log, userData).catch((err) => {
      log(`error tpm raft client conn`, to, err)
      clients[to] = null
      throw err
    })
  }
  return next.then((txrx) => writeStream(txrx[0], msg)).catch((err) => {
    log(`error tpm raft client write`, to, err)
    clients[to] = null
    throw err
  })
}

const sent = {}
const sleep = (ms) => new Promise((res, rej) => setTimeout(res, ms))

function throttleAppend(cmd) {
  const id = JSON.stringify(cmd)
  if (sent[id]) { return }
  sent[id] = raftNode.append(pack(cmd))
    .catch((err) => log(`warn tpm raft append`, err))
    .then(() => sleep(logThrottle))
    .then(() => sent[id] = null)
}

const state = {}
let tpmLeaderSecret = null

// state machine for tpm raft
function onRaftCmd(cmd) {
  if (cmd && typeof cmd.type !== 'string') { throw new Error(`tpm raft type not string`) }
  const isRead = cmd?.type === 'tpm_read'
  const isWrite = cmd?.type === 'tpm_write' && typeof cmd.secret === 'string'
  const hostOk = typeof cmd?.hostId === 'string'
  const secretOk = cmd?.secret === null || typeof cmd?.secret === 'string'
  const isReadAck = cmd?.type === 'tpm_read_ack' && hostOk && secretOk
  const isWriteAck = cmd?.type === 'tpm_write_ack' && hostOk && typeof cmd.secret === 'string'

  // ask tpm what we got
  if (isRead) {
    writeStream(tpmTx, { type: 'tpm_read' })
      .catch((err) => onError(`error tpm client write tpm_read ${err.message}`))
    return
  }

  // ask tpm to write
  if (isWrite) {
    writeStream(tpmTx, { type: 'tpm_write', secret: cmd.secret })
      .catch((err) => onError(`error tpm client write tpm_write ${err.message}`))
    return
  }

  // update what peers have in tpm
  if (isReadAck && cmd.secret) {
    state[cmd.hostId] = cmd.secret
  } else if (isReadAck) {
    state[cmd.hostId] = null
  } else if (isWriteAck) {
    state[cmd.hostId] = cmd.secret
  } else if (cmd !== null) {
    throw new Error(`tpm raft cmd unknown`)
  }

  const now = {}
  raftPeers
    .map((peer) => peer.host_id)
    .forEach((id) => now[id] = state[id])

  const countUnknown = Object.keys(now)
    .filter((id) => now[id] === undefined)
    .length

  // cause all peers to send what they got
  if (countUnknown > 0 && raftNode.state === LEADER) {
    log(`TPM raft leader tpm_read on unknown`)
    const cmd = { type: 'tpm_read' }
    throttleAppend(cmd)
  }

  // dont continue without quorum
  log('TPM raft unknown', countUnknown)
  if (countUnknown >= 2) { return }

  const countEmpty = Object.keys(now)
    .filter((id) => now[id] === null)
    .length

  const allEntry = Object.values(now)
    .filter((entry) => typeof entry === 'string')

  const countEntry = allEntry.length

  // quorum agrees on empty so write secret
  if (countEmpty >= 2 && countEntry <= 0 && raftNode.state === LEADER) {
    log(`TPM raft leader tpm_write on empty`)
    const secret = tpmLeaderSecret ?? crypto.randomBytes(32).toString('base64')
    tpmLeaderSecret = secret
    const cmd = { type: 'tpm_write', secret }
    throttleAppend(cmd)
    return
  }

  // quorum agrees on secret
  if (allEntry.length === 1 && raftNode.state === LEADER) {
    log(`TPM raft leader tpm_write on quorum A`)
    const secret = tpmLeaderSecret = allEntry[0]
    const cmd = { type: 'tpm_write', secret }
    throttleAppend(cmd)
    return
  }

  const allEqual = allEntry.every((entry) => entry === allEntry[0])

  // quorum agrees on secret
  if (allEntry.length === 2 && allEqual && raftNode.state === LEADER) {
    log(`TPM raft leader tpm_write on quorum B`)
    const secret = tpmLeaderSecret = allEntry[0]
    const cmd = { type: 'tpm_write', secret }
    throttleAppend(cmd)
    appApp(PCR, raftPeers, amiPcr, secret, adminPubKey)
    clearTimeout(raftSecretTimer)
    return
  }

  // quorum agrees on secret
  if (allEntry.length >= 3 && allEqual) {
    log('TPM raft 3 equal')
    const secret = allEntry[0]
    appApp(PCR, raftPeers, amiPcr, secret, adminPubKey)
    clearTimeout(raftSecretTimer)
    return
  } else if (allEntry.length === 2 && allEqual) {
    log('TPM raft 2 equal')
    const secret = allEntry[0]
    appApp(PCR, raftPeers, amiPcr, secret, adminPubKey)
    clearTimeout(raftSecretTimer)
    return
  } else if (raftNode.state !== LEADER) {
    log(`TPM raft follower`, countUnknown, countEmpty, countEntry, allEqual)
    return
  }

  log(`TPM raft (error) stalled`, countUnknown, countEmpty, countEntry, allEqual)
}

function unpackOrError(buf) {
  try {
    return unpack(buf)
  } catch (err) {
    onError(`error tpm raft unpack buf`)
  }
}

let raftNode = null
function createTpmRaftNode() {
  const opts = () => {
    const apply = (bufs) => {
      const results = []
      for (const buf of bufs) {
        if (buf === null) {
          // leader appends null buf at start of new term
          // we call onRaftCmd because it moves the state forward
          onRaftCmd(null)
          results.push(null)
          continue
        }
        const cmd = unpackOrError(buf)
        const ok = onRaftCmd(cmd)
        results.push(ok)
      }
      return results
    }
    const read = (buf) => {
      // null read is useful to check liveliness
      if (buf === null) { return null }
      const cmd = unpackOrError(buf)
      const ok = onRaftCmd(cmd)
      return ok
    }
    return { apply, read }
  }
  let logg = new FsLog('/tmp/', 'app')
  logg = new TimeoutLog(logg, { default: logTimeout })
  const ids = raftPeers.map((peer) => peer.host_id)
  raftNode = new RaftNode(hostId, ids, raftSend, logg, opts)
  raftNode.on('error', (err) => onError(new Error(`tpm raft error ${err.message}`)))
}

// rx for tpm raft
function onRaftPeer(err, txrx) {
  if (err) { return onError(err) }
  const [tx, rx] = txrx
  rx.on('data', (msg) => {
    if (!raftNode) { return }
    if (!msg?.from) { return }
    raftNode.onReceive(msg.from, msg)
  })
}

let tpmTx = null
let raftSecretTimer = null

// txrx for khost
function onKhostTpmClient(err, txrx) {
  if (err) { return onError(err) }
  if (tpmTx) { return onError('double tpm client') }
  clearTimeout(kHostTimer)
  log('TPM client ready')
  const [tx, rx] = txrx
  tpmTx = tx

  const close = (err) => {
    log(`error tpm client close`, err)
    onError(err)
  }

  tx.on('error', close)
  rx.on('error', close)
  tx.once('close', () => close('close'))
  rx.once('close', () => close('close'))

  let retry1 = null
  const tpmReadAck = (secret) => {
    const cmd = { type: 'tpm_read_ack', hostId, secret }
    const send = () => {
      raftNode.append(pack(cmd))
        .then(() => clearInterval(retry1))
        .catch((err) => log(`warn tpm raft append`, err))
    }
    clearInterval(retry1)
    retry1 = setInterval(send, 1_000)
    send()
  }

  let retry2 = null
  const tpmWriteAck = (secret) => {
    const cmd = { type: 'tpm_write_ack', hostId, secret }
    const send = () => {
      raftNode.append(pack(cmd))
        .then(() => {
          clearInterval(retry1)
          clearInterval(retry2)
        }).catch((err) => log(`warn tpm raft append`, err))
    }
    clearInterval(retry1)
    clearInterval(retry2)
    retry2 = setInterval(send, 1_000)
    send()
  }

  rx.on('data', (msg) => {
    const secretOk = msg?.secret === null || typeof msg?.secret === 'string'
    const isReadAck = msg?.type === 'tpm_read_ack' && secretOk
    const isWriteAck = msg?.type === 'tpm_write_ack' && typeof msg?.secret === 'string'
    if (isReadAck) {
      tpmReadAck(msg.secret)
    } else if (isWriteAck) {
      tpmWriteAck(msg.secret)
    } else {
      close(`warn tpm client rx unknown ${msg?.type}`)
    }
  })

  const raftLeaderTimer = setTimeout(() => onError(new Error(`tpm raft leader timeout`)), raftLeaderTimeout)
  createTpmRaftNode()
  raftNode.open().then(() => raftNode.awaitLeader()).then(() => {
    clearTimeout(raftLeaderTimer)
    raftSecretTimer = setTimeout(() => onError(new Error(`tpm raft secret timeout`)), raftSecretTimeout)
    writeStream(tx, { type: 'tpm_read' })
      .catch((err) => onError(`error tpm client write tpm_read ${err.message}`))
  })
}

// only talk to khost
const testFnKhost = async (PCR2) => {
  PCR2 = crypto.createHash('sha256').update(PCR2.join('')).digest('hex')
  if (amiPcr !== PCR2) { throw new Error('AMI_PCR != PCR2') }
}

// only talk to (self) peers
let PCR = null
async function getPCR() {
  const attestDoc = await attest()
  const ok = await attestParse(attestDoc)
  PCR = ok.PCR
}

// only talk to (self) peers
const testFnTpmRaft = async (PCR2, userData) => {
  if (PCR.join('') !== PCR2.join('')) { throw new Error('PCR != PCR2') }
  userData = userData ? userData.toString('utf8') : ''
  if (amiPcr !== userData) { throw new Error('AMI_PCR != USER_DATA') }
}

let amiPcr = null
let raftPeers = null
let selfEc2Region = null
let selfEc2Id = null
let adminPubKey = null

// 1 s3 bucket for 3 servers
async function getS3Config() {
  let conf = 'config.yml'
  conf = await s3Get(conf)
  conf = yaml.load(conf.toString('utf8'))
  if (typeof conf?.config !== 'object') { throw new Error('conf no conf') }
  conf = conf.config
  if (typeof conf?.key_ami_pcr !== 'string') { throw new Error('conf no key_ami_pcr') }
  amiPcr = conf.key_ami_pcr
  if (typeof conf?.key_servers !== 'object') { throw new Error('conf no key_servers') }
  raftPeers = Object.values(conf.key_servers)
  const selfIsPeer = raftPeers.some((peer) => peer.host_id === hostId)
  if (!selfIsPeer) { throw new Error('conf no self host_id') }
  selfEc2Region = raftPeers.find((peer) => peer.host_id === hostId).ec2_region
  if (!selfEc2Region) { throw new Error('conf no self ec2_region') }
  selfEc2Id = raftPeers.find((peer) => peer.host_id === hostId).ec2_id
  if (!selfEc2Id) { throw new Error('conf no self ec2_id') }
  if (typeof conf?.admin_pub_key !== 'string') { throw new Error('conf no admin_pub_key') }
  adminPubKey = conf.admin_pub_key
  // runtime will add buf as attest doc user_data
  const buf = Buffer.from(amiPcr)
  const works = [port2, port3, port4, port5]
    .map((port) => `/runtime/user_data_${port - 1}`)
    .map((path) => fs.writeFile(path, buf))
  await Promise.all(works)
}

let kHostEkPub = null
let kHostTimer = null
const args = process.argv.slice(2)
const [port1, port2, port3, port4, port5] = args.map((num) => parseInt(num))

async function main() {
  log('boot')
  await getPCR()
  await getS3Config()
  if (!isTest) { kHostEkPub = await ec2GetEkPub() }
  kHostTimer = setTimeout(() => onError(new Error(`khost connect timeout`)), netConnTimeout)
  await server(port1, testFnKhost, log, onKhostTpmClient, true, kHostEkPub)
  await server(port2, testFnTpmRaft, log, onRaftPeer)
}

main()
  .catch(onError)
