const http = require('http')
const cookies = require('cookie')
const crypto = require('crypto')
const sodium = require('libsodium-wrappers')
const { RaftNode, FsLog, TimeoutLog } = require('tinyraftplus')
const { timeout, client, server } = require('./attest-duplex.js')
const { pack, unpack } = require('msgpackr')
const Database = require('better-sqlite3')
const { v7: uuidv7 } = require('uuid')
const superFs = require('./superfs.js')

const netTimeout = 5_000
const superFsTimeout = 5_000
const raftLeaderTimeout = 120_000
const logTimeout = 1_000

const LEADER = 'leader'
const SUPER_PATH = '/tmp/super1'
const sessionPath = process.env.LH_SESSION_PATH
const hostId = process.env.host_id

function log(...args) {
  console.log.apply(null, [`appapp -`, ...args])
}

function onError(err) {
  log('error', err)
  process.exit(1)
}

function writeHead(res, stat) {
  res.setHeader('Access-Control-Max-Age', 9999999)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, POST, GET')
  stat !== 200 && res.setHeader('Content-Type', 'text/plain')
  stat === 200 && res.setHeader('Content-Type', 'application/json')
  res.writeHead(stat)
}

function on500(err, req, res, code=500) {
  log('http 500 warn', code, req.url, err)
  writeHead(res, code)
  res.end(code+'')
}

function on400(req, res, code=400) {
  log('http 400', code, req.url)
  writeHead(res, code)
  res.end(code+'')
}

function paramsOfPath(path) {
  const query = path.split('?')[1] ?? path
  try {
    return Object.fromEntries(new URLSearchParams(query))
  } catch (err) {
    return {}
  }
}

const noop = () => {}

function readBody(req) {
  const [timer, timedout] = timeout(netTimeout)
  const read = new Promise((res, rej) => {
    timedout.catch((err) => rej(new Error('http read timeout')))
    const parts = []
    req.on('error', rej)
    req.on('data', (chunk) => parts.push(chunk))
    req.once('end', () => res(Buffer.concat(parts)))
  })
  read.catch(noop).finally(() => clearTimeout(timer))
  return read
}

function readJson(buf) {
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch (err) {
    return {}
  }
}

const isStrLen = (arg, len1, len2) => {
  if (typeof arg !== 'string') { return false }
  if (!len2) { return arg.length === len1 }
  return arg.length >= len1 && arg.length <= len2
}

async function readAdminQuery(req, res) {
  let sig = req.headers['x-admin-signature']
  if (!isStrLen(sig, 64, 128)) { return on400(req, res) }
  let query = req.url.split('?')[1]
  if (!query) { query = await readBody(req) }

  try {

    sig = Buffer.from(sig, 'base64')
    const buf = Buffer.isBuffer(query) ? query : Buffer.from(query)
    const keyPub = Buffer.from(adminPubKey, 'base64')
    if (!sodium.crypto_sign_verify_detached(sig, buf, keyPub)) { return on400(req, res, 401) }
    return Buffer.isBuffer(query) ? readJson(query) : paramsOfPath(query)

  } catch (err) {
    return on400(req, res)
  }
}

async function readDevQuery(req, res) {
  let sig = req.headers['x-dev-signature']
  if (!isStrLen(sig, 64, 128)) { return on400(req, res) }
  const devId = req.headers['x-dev-id']
  if (!isStrLen(devId, 32)) { return on400(req, res) }
  let query = req.url.split('?')[1]
  if (!query) { query = await readBody(req) }

  const cmd = { type: 'get_dev_sign_key_pub', devId }
  const [seq, result] = await raftNode.read(pack(cmd))
  if (!result?.keyPub) { return on400(req, res, 401) }
  const { organizations } = result

  try {

    sig = Buffer.from(sig, 'base64')
    const buf = Buffer.isBuffer(query) ? query : Buffer.from(query)
    const keyPub = Buffer.from(result.keyPub, 'base64')
    if (!sodium.crypto_sign_verify_detached(sig, buf, keyPub)) { return on400(req, res, 401) }
    const params = Buffer.isBuffer(query) ? readJson(query) : paramsOfPath(query)
    if (params.orgId && !organizations.includes(params.orgId)) { return on400(req, res, 403) }
    return { ...params, devId, organizations }

  } catch (err) {
    return on400(req, res)
  }
}

const cache = {}

async function readAppQuery(req, res) {
  let sig = req.headers['x-app-signature']
  if (!isStrLen(sig, 64, 128)) { return on400(req, res) }
  const appVersion = req.headers['x-app-version']
  if (!isStrLen(appVersion, 32)) { return on400(req, res) }
  let query = req.url.split('?')[1]
  if (!query) { query = await readBody(req) }

  let cached = cache[appVersion]
  if (!cached) {
    const cmd = { type: 'get_app_v_sign_key_pub', appVersion }
    const [seq, result] = await raftNode.read(pack(cmd))
    if (!result?.keyPub) { return on400(req, res, 401) }
    cached = cache[appVersion] = result
  }
  const { orgId, appId } = cached

  try {

    sig = Buffer.from(sig, 'base64')
    const buf = Buffer.isBuffer(query) ? query : Buffer.from(query)
    const keyPub = Buffer.from(cached.keyPub, 'base64')
    if (!sodium.crypto_sign_verify_detached(sig, buf, keyPub)) { return on400(req, res, 401) }
    const params = Buffer.isBuffer(query) ? readJson(query) : paramsOfPath(query)
    return { ...params, orgId, appId, appVersion }

  } catch (err) {
    return on400(req, res)
  }
}

async function createOrg(req, res) {
  const params = await readAdminQuery(req, res)
  if (!params) { return }

  let { orgId, orgName, devId, devKeyPub, devEmail } = params
  if (!isStrLen(orgId, 32)) { return on400(req, res) }
  if (!isStrLen(orgName, 1, 128)) { return on400(req, res) }
  if (!isStrLen(devId, 32)) { return on400(req, res) }

  devKeyPub = typeof devKeyPub === 'string' ? devKeyPub : ''
  devKeyPub = Buffer.from(devKeyPub, 'base64')
  if (devKeyPub.length !== 32) { return on400(req, res) }
  devKeyPub = devKeyPub.toString('base64')
  if (!isStrLen(devEmail, 1, 128)) { return on400(req, res) }

  const attestSecret = crypto.randomBytes(32).toString('hex')
  const timeMs = Date.now()

  log('create org', orgId, orgName, devId, devEmail)
  const cmd = { type: 'create_org', orgId, orgName, devId, devKeyPub, devEmail, attestSecret, timeMs }
  const [seq, result] = await raftNode.append(pack(cmd))

  writeHead(res, 200)
  res.end(JSON.stringify(result))
}

async function createApp(req, res) {
  const params = await readDevQuery(req, res)
  if (!params) { return }

  const { orgId, devId, appName } = params
  if (!isStrLen(orgId, 32)) { return on400(req, res) }
  if (!isStrLen(devId, 32)) { return on400(req, res) }
  if (!isStrLen(appName, 1, 128)) { return on400(req, res) }

  const timeMs = Date.now()
  const appId = uuidv7().replaceAll('-', '')

  log('create app', orgId, devId, appName, appId)
  const cmd = { type: 'create_app', orgId, devId, appName, appId, timeMs }
  const [seq, result] = await raftNode.append(pack(cmd))

  writeHead(res, 200)
  res.end(JSON.stringify(result))
}

async function createAppVersion(req, res) {
  const params = await readDevQuery(req, res)
  if (!params) { return }

  const { orgId, appId, devId, versionName, versionPcr } = params
  if (!isStrLen(orgId, 32)) { return on400(req, res) }
  if (!isStrLen(appId, 32)) { return on400(req, res) }
  if (!isStrLen(devId, 32)) { return on400(req, res) }
  if (!isStrLen(versionName, 1, 128)) { return on400(req, res) }
  if (!isStrLen(versionPcr, 64)) { return on400(req, res) }

  const appVersionId = uuidv7().replaceAll('-', '')
  let signKey = sodium.crypto_sign_keypair()
  const signKeyPub = Buffer.from(signKey.publicKey).toString('base64')
  signKey = Buffer.from(signKey.privateKey).toString('base64')
  const timeMs = Date.now()

  log('create app version', orgId, appId, devId, versionName, versionPcr, appVersionId)
  const cmd = { type: 'create_app_version', orgId, appId, devId, versionName, versionPcr, appVersionId, signKey, signKeyPub, timeMs }
  const [seq, result] = await raftNode.append(pack(cmd))

  writeHead(res, 200)
  res.end(JSON.stringify(result))
}

async function getAppKey(req, res) {
  const params = await readAppQuery(req, res)
  if (!params) { return }

  const { orgId, appId, appVersion, name } = params
  if (!isStrLen(orgId, 32)) { return on400(req, res) }
  if (!isStrLen(appId, 32)) { return on400(req, res) }
  if (!isStrLen(appVersion, 32)) { return on400(req, res) }
  if (!isStrLen(name, 1, 128)) { return on400(req, res) }

  log('get app key')
  const cmd = { type: 'get_app_key', orgId, appId, appVersion, name }
  let [seq, result] = await raftNode.read(pack(cmd))
  result = result ?? { orgId, appId, name, data: null }

  writeHead(res, 200)
  res.end(JSON.stringify(result))
}

async function genAppKey(req, res) {
  const params = await readAppQuery(req, res)
  if (!params) { return }

  let { orgId, appId, appVersion, name, length, lock, replace } = params
  if (!isStrLen(orgId, 32)) { return on400(req, res) }
  if (!isStrLen(appId, 32)) { return on400(req, res) }
  if (!isStrLen(appVersion, 32)) { return on400(req, res) }
  if (!isStrLen(name, 1, 128)) { return on400(req, res) }

  length = parseInt(length)
  if (isNaN(length)) { return on400(req, res) }
  if (length < 16 || length > 128) { return on400(req, res) }
  const data = crypto.randomBytes(length).toString('base64')
  lock = lock === true || lock === 'true'
  replace = replace === true || replace === 'true'
  const timeMs = Date.now()

  log('gen app key')
  const cmd = { type: 'gen_app_key', orgId, appId, appVersion, name, length, data, lock, replace, timeMs }
  const [seq, result] = await raftNode.append(pack(cmd))

  writeHead(res, 200)
  res.end(JSON.stringify(result))
}

async function setAppKey(req, res) {
  const params = await readAppQuery(req, res)
  if (!params) { return }

  let { orgId, appId, appVersion, name, data, lock, replace } = params
  if (!isStrLen(orgId, 32)) { return on400(req, res) }
  if (!isStrLen(appId, 32)) { return on400(req, res) }
  if (!isStrLen(appVersion, 32)) { return on400(req, res) }
  if (!isStrLen(name, 1, 128)) { return on400(req, res) }

  data = typeof data === 'string' ? data : ''
  data = Buffer.from(data, 'base64')
  if (data.length < 16 || data.length > 128) { return on400(req, res) }
  data = data.toString('base64')
  lock = lock === true || lock === 'true'
  replace = replace === true || replace === 'true'
  const timeMs = Date.now()

  log('set app key')
  const cmd = { type: 'set_app_key', orgId, appId, appVersion, name, data, lock, replace, timeMs }
  const [seq, result] = await raftNode.append(pack(cmd))

  writeHead(res, 200)
  res.end(JSON.stringify(result))
}

async function rmAppKey(req, res) {
  const params = await readAppQuery(req, res)
  if (!params) { return }

  let { orgId, appId, appVersion, name, data, lock, replace } = params
  if (!isStrLen(orgId, 32)) { return on400(req, res) }
  if (!isStrLen(appId, 32)) { return on400(req, res) }
  if (!isStrLen(appVersion, 32)) { return on400(req, res) }
  if (!isStrLen(name, 1, 128)) { return on400(req, res) }

  log('rm app key')
  const cmd = { type: 'rm_app_key', orgId, appId, appVersion, name }
  const [seq, result] = await raftNode.append(pack(cmd))

  writeHead(res, 200)
  res.end(JSON.stringify(result))
}

async function getRaft(req, res) {
  log('get raft')
  try {
    await raftNode.read(null)
    const { term, seq, state, leader } = raftNode
    const json = { term: term + '', seq: seq + '' , state, leader }
    log('got raft', json)
    writeHead(res, 200)
    res.end(JSON.stringify(json))
  } catch (err) {
    log(`warn app raft read`, err)
    err = err.message
    const { term, seq, state, leader } = raftNode
    const json = { term: term + '', seq: seq + '' , state, leader, err }
    writeHead(res, 408)
    res.end(JSON.stringify(json))
  }
}

async function getTest(req, res) {
  log('get test')
  const html = await fetch('http://example.com')
    .then((res) => res.text())
  writeHead(res, 200)
  res.end(html)
}

const httpServer = http.createServer(async (req, res) => {
  const path = req.url.split('?')[0]

  // cors
  if (req.method === 'OPTIONS') {
    writeHead(res, 204)
    res.end()
    return
  }

  try {

    const prefix = sessionPath
    if (path === `${prefix}/create-org`) {
      await createOrg(req, res)
    } else if (path === `${prefix}/create-app`) {
      await createApp(req, res)
    } else if (path === `${prefix}/create-app-version`) {
      await createAppVersion(req, res)
    } else if (path === `${prefix}/get-app-key`) {
      await getAppKey(req, res)
    } else if (path === `${prefix}/gen-app-key`) {
      await genAppKey(req, res)
    } else if (path === `${prefix}/set-app-key`) {
      await setAppKey(req, res)
    } else if (path === `${prefix}/rm-app-key`) {
      await rmAppKey(req, res)
    } else if (path === `${prefix}/raft`) {
      await getRaft(req, res)
    } else if (path === `${prefix}/test`) {
      await getTest(req, res)
    } else {
      on400(req, res, 404)
    }

  } catch(err) {
    try {
      on500(err, req, res)
    } catch (err) { }
  }
})

httpServer.requestTimeout = 10 * 1000
httpServer.headersTimeout = 10 * 1000
httpServer.once('close', () => onError(new Error('http server close')))

function writeStream(stream, data) {
  const [timer, timedout] = timeout(netTimeout)
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

// tx for app raft
function raftSend(to, msg) {
  to = `https://${to}:${port3 - 1}${sessionPath}`
  let next = clients[to]
  if (!next) {
    const userData = Buffer.from(amiPcr)
    next = clients[to] = client(to, testFnAppRaft, log, userData).catch((err) => {
      log(`error app raft client conn`, to, err)
      clients[to] = null
      throw err
    })
  }
  return next.then((txrx) => writeStream(txrx[0], msg)).catch((err) => {
    log(`error app raft client write`, to, err)
    clients[to] = null
    throw err
  })
}

// state machine for app raft
function onRaftCmd(cmd, seq) {
  log('app apply', cmd ? cmd.type : cmd, seq)

  const findOrCreateDev = (id, email, keyPub, timeMs) => {
    const dev = db.prepare('SELECT * FROM developers WHERE id = ?').get(id)
    if (dev) { return dev }
    const info = db.prepare(`
      INSERT INTO developers (id, email, key_pub, created_at)
        VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING
    `).run(id, email, keyPub, timeMs)
    if (info.changes === 0) { return 'developer email not unique' }
    return db.prepare('SELECT * FROM developers WHERE id = ?').get(id)
  }

  const findOrCreateOrg = (id, name, attestSecret, devId, timeMs) => {
    const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(id)
    if (org) { return org }
    const info = db.prepare(`
      INSERT INTO organizations (id, name, attest_secret, created_by, created_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
    `).run(id, name, attestSecret, devId, timeMs)
    if (info.changes === 0) { return 'organization name not unique' }
    return db.prepare('SELECT * FROM organizations WHERE id = ?').get(id)
  }

  const addDevToOrg = (orgId, devId, timeMs) => {
    db.prepare(`
      INSERT INTO org_devs (org_id, dev_id, created_at) SELECT ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM org_devs WHERE org_id = ? AND dev_id = ?)
    `).run(orgId, devId, timeMs, orgId, devId)
  }

  const checkpoint = (res) => {
    db.prepare(`UPDATE raft_seq SET apply_seq = ? WHERE id = 0`).run(seq)
    return res
  }

  const findOrCreateDevOrg = db.transaction((cmd) => {
    const { devId, devEmail, devKeyPub, orgId, orgName, attestSecret, timeMs } = cmd
    const dev = findOrCreateDev(devId, devEmail, devKeyPub, timeMs)
    if (typeof dev === 'string') { return checkpoint({ error: dev }) }
    const org = findOrCreateOrg(orgId, orgName, attestSecret, devId, timeMs)
    if (typeof org === 'string') { return checkpoint({ error: org }) }
    addDevToOrg(orgId, devId, timeMs)
    return checkpoint({ dev, org })
  })

  if (cmd.type === 'create_org') {
    return findOrCreateDevOrg.immediate(cmd)
  }

  if (cmd.type === 'get_dev_sign_key_pub') {
    const { devId } = cmd
    const row = db.prepare('SELECT * FROM developers WHERE id = ?').get(devId)
    if (!row) { return null }
    const rows = db.prepare('SELECT * FROM org_devs WHERE dev_id = ?').all(devId)
    const organizations = rows.map((row) => row.org_id)
    return { keyPub: row.key_pub, organizations }
  }

  const findOrCreateApp = db.transaction((id, name, orgId, devId, timeMs) => {
    let app = db.prepare('SELECT * FROM apps WHERE id = ? OR (org_id = ? AND name = ?)').get(id, orgId, name)
    if (app) { return checkpoint(app) }

    const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId)
    const dev = db.prepare('SELECT * FROM developers WHERE id = ?').get(devId)
    if (!org) { return checkpoint({ error: 'organization not found' }) }
    if (!dev) { return checkpoint({ error: 'developer not found' }) }

    const rows = db.prepare('SELECT * FROM org_devs WHERE dev_id = ?').all(devId)
    const orgs = rows.map((row) => row.org_id)
    if (!orgs.includes(orgId)) { return checkpoint({ error: 'developer not authorized' }) }

    db.prepare(`INSERT INTO apps (id, name, org_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)`).run(id, name, orgId, devId, timeMs)
    app = db.prepare('SELECT * FROM apps WHERE id = ?').get(id)
    return checkpoint(app)
  })

  if (cmd.type === 'create_app') {
    const { appId, appName, orgId, devId, timeMs } = cmd
    return findOrCreateApp.immediate(appId, appName, orgId, devId, timeMs)
  }

  const findOrCreateAppVersion = db.transaction((id, name, orgId, appId, devId, pcr, signKey, signKeyPub, timeMs) => {
    let appv = db.prepare('SELECT * FROM app_versions WHERE id = ? OR (app_id = ? AND name = ?) OR (app_id = ? AND pcr = ?)').get(id, appId, name, appId, pcr)
    if (appv) { return checkpoint(appv) }

    const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId)
    const dev = db.prepare('SELECT * FROM developers WHERE id = ?').get(devId)
    const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(appId)
    if (!org) { return checkpoint({ error: 'organization not found' }) }
    if (!dev) { return checkpoint({ error: 'developer not found' }) }
    if (!app) { return checkpoint({ error: 'app not found' }) }

    const rows = db.prepare('SELECT * FROM org_devs WHERE dev_id = ?').all(devId)
    const orgs = rows.map((row) => row.org_id)
    if (!orgs.includes(orgId)) { return checkpoint({ error: 'developer not authorized' }) }
    if (app.org_id !== orgId) { return checkpoint({ error: 'app does not belong to org' }) }

    db.prepare(`
      INSERT INTO app_versions (id, name, org_id, app_id, created_by, pcr, sign_key, sign_key_pub, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, orgId, appId, devId, pcr, signKey, signKeyPub, timeMs)
    appv = db.prepare('SELECT * FROM app_versions WHERE id = ?').get(id)
    return checkpoint(appv)
  })

  if (cmd.type === 'create_app_version') {
    const { appVersionId, versionName, orgId, appId, devId, versionPcr, signKey, signKeyPub, timeMs } = cmd
    const ok = findOrCreateAppVersion.immediate(appVersionId, versionName, orgId, appId, devId, versionPcr, signKey, signKeyPub, timeMs)
    if (ok.error) { return ok }
    delete ok['sign_key']
    delete ok['sign_key_pub']
    return ok
  }

  if (cmd.type === 'get_app_v') {
    const { appId, versionPcr } = cmd
    const row = db.prepare('SELECT * FROM app_versions WHERE app_id = ? AND pcr = ?').get(appId, versionPcr)
    if (!row) { return null }
    return { appVersion: row.id, orgId: row.org_id, appId }
  }

  if (cmd.type === 'get_app_v_sign_key') {
    const { appVersion, attestSecret } = cmd
    const row = db.prepare(`
      SELECT av.org_id AS oid, av.app_id AS aid, av.sign_key AS sign FROM app_versions av
        JOIN organizations o ON o.id = av.org_id WHERE av.id = ? AND o.attest_secret = ?
    `).get(appVersion, attestSecret)
    if (!row) { return null }
    return { signKey: row.sign, orgId: row.oid, appId: row.aid }
  }

  if (cmd.type === 'get_app_v_sign_key_pub') {
    const { appVersion } = cmd
    const row = db.prepare('SELECT * FROM app_versions WHERE id = ?').get(appVersion)
    if (!row) { return null }
    return { keyPub: row.sign_key_pub, orgId: row.org_id, appId: row.app_id }
  }

  // todo: key modes
  if (cmd.type === 'get_app_key') {
    const { orgId, appId, appVersion, name } = cmd
    const key = db.prepare('SELECT * FROM app_keys WHERE app_id = ? AND name = ?').get(appId, name)
    if (!key) { return null }
    return { orgId: key.org_id, appId: key.app_id, name: key.name, data: key.data }
  }

  // todo: key modes
  const writeAppKey = db.transaction((orgId, appId, appVersion, name, data, lock, replace, timeMs) => {
    let key = db.prepare('SELECT * FROM app_keys WHERE app_id = ? AND name = ?').get(appId, name)
    if (!key) {
      db.prepare(`
        INSERT INTO app_keys (name, org_id, app_id, created_by, data, mode, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(name, orgId, appId, appVersion, data, 1, timeMs)
      return checkpoint({ orgId, appId, name, data })
    } else if (!replace) {
      return checkpoint({ orgId: key.org_id, appId: key.app_id, name: key.name, data: key.data })
    }
    db.prepare(`UPDATE app_keys SET data = ? WHERE app_id = ? AND name = ?`).run(data, appId, name)
    return checkpoint({ orgId, appId, name, data })
  })

  if (cmd.type === 'gen_app_key' || cmd.type === 'set_app_key') {
    const { orgId, appId, appVersion, name, data, lock, replace, timeMs } = cmd
    return writeAppKey.immediate(orgId, appId, appVersion, name, data, lock, replace, timeMs)
  }

  // todo: key modes
  const rmAppKey = db.transaction((orgId, appId, appVersion, name) => {
    db.prepare(`DELETE FROM app_keys WHERE app_id = ? AND name = ?`).run(appId, name)
    return checkpoint({ orgId, appId, name, data: null })
  })

  if (cmd.type === 'rm_app_key') {
    const { orgId, appId, appVersion, name } = cmd
    return rmAppKey.immediate(orgId, appId, appVersion, name)
  }

  throw new Error(`app raft cmd ${cmd?.type} unknown`)
}

let db = null
let applySeq = null
function createAppDb() {
  db = new Database(`${SUPER_PATH}/appapp.db`, {})
  db.pragma('journal_mode = TRUNCATE')
  db.pragma('synchronous = FULL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS raft_seq (
      id INTEGER PRIMARY KEY,
      apply_seq INTEGER NOT NULL
    );`
  )

  const test = db.prepare('SELECT * FROM raft_seq WHERE id = 0').get()
  db.prepare(`INSERT INTO raft_seq (id, apply_seq) VALUES (0, -1) ON CONFLICT DO NOTHING`).run()
  applySeq = db.prepare('SELECT * FROM raft_seq WHERE id = 0').get().apply_seq
  applySeq = BigInt(applySeq)

  db.exec(`
    CREATE TABLE IF NOT EXISTS developers (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      key_pub TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );`
  )

  db.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      attest_secret TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (created_by) REFERENCES developers(id)
    );`
  )

  db.exec(`
    CREATE TABLE IF NOT EXISTS org_devs (
      org_id TEXT NOT NULL,
      dev_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (org_id) REFERENCES organizations(id),
      FOREIGN KEY (dev_id) REFERENCES developers(id),
      PRIMARY KEY (org_id, dev_id)
    );`
  )

  db.exec(`
    CREATE TABLE IF NOT EXISTS apps (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      org_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (org_id) REFERENCES organizations(id),
      FOREIGN KEY (created_by) REFERENCES developers(id),
      UNIQUE (org_id, name)
    );`
  )

  db.exec(`
    CREATE TABLE IF NOT EXISTS app_versions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      org_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      pcr TEXT NOT NULL,
      sign_key TEXT NOT NULL,
      sign_key_pub TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (org_id) REFERENCES organizations(id),
      FOREIGN KEY (app_id) REFERENCES apps(id),
      FOREIGN KEY (created_by) REFERENCES developers(id),
      UNIQUE (app_id, name),
      UNIQUE (app_id, pcr)
    );`
  )

  db.exec(`
    CREATE TABLE IF NOT EXISTS app_keys (
      name TEXT NOT NULL,
      org_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      data TEXT NOT NULL,
      mode INTEGER NOT NULL CHECK (mode >= 1 AND mode <= 3),
      created_at INTEGER NOT NULL,
      FOREIGN KEY (org_id) REFERENCES organizations(id),
      FOREIGN KEY (app_id) REFERENCES apps(id),
      FOREIGN KEY (created_by) REFERENCES app_versions(id),
      PRIMARY KEY (app_id, name)
    );`
  )
}

function unpackOrError(buf) {
  try {
    return unpack(buf)
  } catch (err) {
    onError(`error app raft unpack buf`)
  }
}

let raftNode = null
function createAppRaftNode() {
  const opts = () => {
    const apply = (bufs, seq) => {
      const results = []
      for (const buf of bufs) {
        if (buf === null) {
          // leader appends null buf at start of new term
          results.push(null)
          seq++
          continue
        }
        const cmd = unpackOrError(buf)
        const ok = onRaftCmd(cmd, seq)
        results.push(ok)
        seq++
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
    const longer = 2_500
    return { apply, read, applySeq, appendTimeout: longer, readTimeout: longer }
  }

  let logg = new FsLog(`${SUPER_PATH}/`, 'appapp')
  logg = new TimeoutLog(logg, { default: logTimeout })
  const ids = raftPeers.map((peer) => peer.host_id)
  raftNode = new RaftNode(hostId, ids, raftSend, logg, opts)
  raftNode.on('error', (err) => onError(new Error(`app raft error ${err.message}`)))
}

// rx for app raft
function onRaftPeer(err, txrx) {
  if (err) { return onError(err) }
  const [tx, rx] = txrx
  rx.on('data', (msg) => {
    if (!msg?.from) { return }
    log(msg.from, msg.type)
    raftNode.onReceive(msg.from, msg)
  })
}

// only talk to (self) peers
const testFnAppRaft = async (PCR2, userData) => {
  if (PCR.join('') !== PCR2.join('')) { throw new Error('PCR != PCR2') }
  userData = userData ? userData.toString('utf8') : ''
  if (amiPcr !== userData) { throw new Error('AMI_PCR != USER_DATA') }
}

// allow apps to attest
const testFnAppClient = async (PCR2, userData) => {
  const appId = userData ? userData.toString('utf8') : ''
  const versionPcr = crypto.createHash('sha256').update(PCR2.join('')).digest('hex')
  const cmd = { type: 'get_app_v', appId, versionPcr }
  const [seq, result] = await raftNode.read(pack(cmd))
  if (!result) { throw new Error(`No app (${appId}) with PCR (${versionPcr})`) }
  const { appVersion } = result
  return [appId, appVersion]
}

// allow attested apps to get their signing key
function onAppClient(err, ok) {
  if (err) { return onError(err) }
  const [tx, rx, attestData] = ok
  const [appId, appVersion] = attestData

  const close = () => {
    tx.destroy()
    rx.destroy()
    clearTimeout(timer)
  }

  tx.once('close', close)
  rx.once('close', close)
  const timer = setTimeout(close, netTimeout)

  const getAppSignKey = (attestSecret) => {
    if (!isStrLen(attestSecret, 64)) { return close() }
    clearTimeout(timer)
    const cmd = { type: 'get_app_v_sign_key', appVersion, attestSecret }
    raftNode.read(pack(cmd))
      .then((res) => {
        const [seq, ok] = res
        const signKey = ok?.signKey ?? null
        return writeStream(tx, { type: 'get_app_v_sign_key_ack', appVersion, signKey })
          .catch(close)
      })
      .catch((err) => {
        log(`warn app raft read`, err)
        close()
      })
  }

  rx.on('data', (msg) => {
    if (msg?.type !== 'get_app_v_sign_key') { return close() }
    getAppSignKey(msg.attestSecret)
  })

  writeStream(tx, { type: 'duplex_ready' })
    .catch(close)
}

let PCR = null
let raftPeers = null
let amiPcr = null
let sqliteSecret = null
let adminPubKey = null

const args = process.argv.slice(2)
const [port1, port2, port3, port4, port5] = args.map((num) => parseInt(num))

module.exports = function appApp(pcr1, peers, pcr2, secret, adminKey) {
  if (PCR) { return }
  PCR = pcr1
  raftPeers = peers
  amiPcr = pcr2
  sqliteSecret = secret
  adminPubKey = adminKey
  const namespace = `lhks_${hostId}`.replaceAll('.', '_')
  const psqlUrl = raftPeers.find((peer) => peer.host_id === hostId).psql_url
  const superFsTimer = setTimeout(() => onError(new Error(`superfs mount timeout`)), superFsTimeout)
  superFs(namespace, SUPER_PATH, psqlUrl, sqliteSecret, onError).then(() => {
    clearTimeout(superFsTimer)
    log('superfs ready')
    try { createAppDb() } catch(err) { onError(err) }
    createAppRaftNode()
    const raftLeaderTimer = setTimeout(() => onError(new Error(`app raft leader timeout`)), raftLeaderTimeout)
    return server(port3, testFnAppRaft, log, onRaftPeer).then(() => {
      return raftNode.open().then(() => raftNode.awaitLeader(0)).then(() => {
        clearTimeout(raftLeaderTimer)
        return server(port5, testFnAppClient, log, onAppClient)
          .then(() => httpServer.listen(port4, '127.0.0.1', () => log('app app ready')))
      })
    })
  }).catch(onError)
}
