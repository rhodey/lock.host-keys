const fs = require('fs/promises')
const crypto = require('crypto')
const minimist = require('minimist')
const duplex = require('/runtime/attest-duplex.js')
const { FetchHelper } = require('/runtime/dispatch.js')
const sodium = require('libsodium-wrappers')

// for local dev

const netTimeout = 5 * 1000

const defaults = {}
defaults['target-csv'] = '/runtime/target.csv'

function log(...args) {
  console.error.apply(null, args)
}

function onError(err) {
  log('error', err)
  process.exit(1)
}

const isStrLen = (arg, len1, len2) => {
  if (typeof arg !== 'string') { return false }
  if (!len2) { return arg.length === len1 }
  return arg.length >= len1 && arg.length <= len2
}

async function readFile(path) {
  try {
    return await fs.readFile(path)
  } catch (err) {
    if (err.code === 'ENOENT') { return null }
    throw err
  }
}

function readTargetCsv(targetCsv, target) {
  let csv = targetCsv.toString('utf8')
  csv = csv.split(`\n`).map((line) => line.trim())
  csv = csv.find((line) => line.startsWith(target))
  if (!csv) { throw new Error(`target csv no ${target}`) }
  const [t, url, nitroPcr, amiPcr] = csv.split(`,`)
  if (!url) { throw new Error(`target csv no url`) }
  if (!url.startsWith('https://')) { throw new Error(`target csv no https url`) }
  if (!isStrLen(nitroPcr, 64)) { throw new Error(`target csv nitroPcr not 64`) }
  if (!isStrLen(amiPcr, 64)) { throw new Error(`target csv amiPcr not 64`) }
  return [target, url, nitroPcr, amiPcr]
}

function testFnFn(arr) {
  const [target, u, nitroPcr, amiPcr] = arr
  return async function testFn(PCR2, userData) {
    PCR2 = crypto.createHash('sha256').update(PCR2.join('')).digest('hex')
    if (nitroPcr !== PCR2) { throw new Error(`Nitro PCR does not match (${target})`) }
    userData = userData ? userData.toString('utf8') : ''
    if (amiPcr !== userData) { throw new Error(`AMI PCR does not match (${target})`) }
  }
}

async function main() {
  log(`main`)
  await sodium.ready
  let args = minimist(process.argv.slice(2))
  args = Object.assign(defaults, args)

  const { target } = args
  let targetCsv = args['target-csv']
  targetCsv = await readFile(targetCsv)
  if (!isStrLen(target, 1, 128)) {
    onError('--target is needed')
  } else if (targetCsv === null) {
    onError(`${args['target-csv']} is empty`)
  }

  const arr = readTargetCsv(targetCsv, target)
  const testFn = testFnFn(arr)
  const [t, url] = arr

  const cmds = ['create-org', 'create-app', 'create-app-version']
  const cmd = cmds.find((cmd) => args[cmd] !== undefined)
  const nameArg = args[cmd]

  if (!cmd) {
    onError('cmd is needed')
  } else if (!isStrLen(nameArg, 1, 128)) {
    onError(`--${cmd} needs name 1 to 128 chars`)
  }

  log(`target ${target}`)
  log(`command ${cmd}`)
  log(`name arg ${nameArg}`)

  const [h, path] = duplex.urlToHostAndPath(url)
  const dispatcher = new FetchHelper(testFn, path)
  let [adminKey, devKey] = [null, null]

  const signAndFetch = async (url, query, body) => {
    const devId = (query ?? body).devId
    query = query ? new URLSearchParams(query).toString() : null
    body = body ? JSON.stringify(body) : null
    const plain = query ? Buffer.from(query) : Buffer.from(body)
    const signKey = adminKey ?? devKey
    let sig = sodium.crypto_sign_detached(plain, signKey)
    sig = Buffer.from(sig).toString('base64')
    const headers = {}
    const name = adminKey ? 'x-admin-signature' : 'x-dev-signature'
    headers[name] = sig
    devKey && (headers['x-dev-id'] = devId)
    let next = null
    if (query) {
      url = `${url}?${query}`
      next = fetch(url, { dispatcher, method: 'GET', headers })
    } else {
      next = fetch(url, { dispatcher, method: 'POST', headers, body: plain })
    }
    return next.then((res) => {
      if (!res.ok) { throw new Error(`status ${res.status}`) }
      return res
    }).then((ok) => {
      return ok.json().catch((err) => { throw new Error(`not json`) })
    })
  }

  if (cmd === 'create-org') {
    const keys = ['org-id', 'dev-id', 'dev-key-pub', 'dev-email']
    let [orgId, devId, devKeyPub, devEmail] = keys.map((key) => args[key])

    if (!isStrLen(orgId, 32)) {
      onError('--org-id needs length 32')
    } else if (!isStrLen(devId, 32)) {
      onError('--dev-id needs length 32')
    } else if (!isStrLen(devKeyPub, 32, 64)) {
      onError('--dev-key-pub needs length >= 32 <= 64')
    } else if (!isStrLen(devEmail, 1, 128)) {
      onError('--dev-email needs length >= 1 <= 128')
    }

    devKeyPub = Buffer.from(devKeyPub, 'base64')
    if (devKeyPub.length !== 32) {
      onError('--dev-key-pub needs length 32')
    }

    adminKey = process.env.ADMIN_KEY
    if (!isStrLen(adminKey, 64, 128)) {
      onError('env ADMIN_KEY needs length >= 64 <= 128')
    }

    adminKey = Buffer.from(adminKey, 'base64')
    if (adminKey.length !== 64) {
      onError('env ADMIN_KEY needs length 64')
    }

    const api = `${url}/create-org`
    devKeyPub = devKeyPub.toString('base64')
    const query = { orgId, orgName: nameArg, devId, devKeyPub, devEmail }
    log(api)
    const json = await signAndFetch(api, null, query)
    console.log(JSON.stringify(json))
    process.exit(0)
  }

  if (cmd === 'create-app') {
    const keys = ['org-id', 'dev-id']
    let [orgId, devId] = keys.map((key) => args[key])

    if (!isStrLen(orgId, 32)) {
      onError('--org-id needs length 32')
    } else if (!isStrLen(devId, 32)) {
      onError('--dev-id needs length 32')
    }

    devKey = process.env.DEV_KEY
    if (!isStrLen(devKey, 64, 128)) {
      onError('env DEV_KEY needs length >= 64 <= 128')
    }

    devKey = Buffer.from(devKey, 'base64')
    if (devKey.length !== 64) {
      onError('env DEV_KEY needs length 64')
    }

    const api = `${url}/create-app`
    const query = { orgId, devId, appName: nameArg }
    log(api)
    const json = await signAndFetch(api, null, query)
    console.log(JSON.stringify(json))
    process.exit(0)
  }

  if (cmd === 'create-app-version') {
    const keys = ['org-id', 'dev-id', 'app-id', 'version-pcr']
    let [orgId, devId, appId, versionPcr] = keys.map((key) => args[key])

    if (!isStrLen(orgId, 32)) {
      onError('--org-id needs length 32')
    } else if (!isStrLen(devId, 32)) {
      onError('--dev-id needs length 32')
    } else if (!isStrLen(appId, 32)) {
      onError('--app-id needs length 32')
    } else if (!isStrLen(versionPcr, 64)) {
      onError('--version-pcr needs length 64')
    }

    devKey = process.env.DEV_KEY
    if (!isStrLen(devKey, 64, 128)) {
      onError('env DEV_KEY needs length >= 64 <= 128')
    }

    devKey = Buffer.from(devKey, 'base64')
    if (devKey.length !== 64) {
      onError('env DEV_KEY needs length 64')
    }

    const api = `${url}/create-app-version`
    const query = { orgId, devId, appId, versionName: nameArg, versionPcr }
    log(api)
    const json = await signAndFetch(api, null, query)
    console.log(JSON.stringify(json))
    process.exit(0)
  }

  onError('cmd is needed')
}

main()
  .catch(onError)
