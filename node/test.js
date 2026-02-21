const fs = require('fs')
const test = require('tape')
const crypto = require('crypto')
const exec = require('child_process').exec

const ADMIN_KEY = process.env.ADMIN_KEY
const TARGET = process.env.TARGET

const sleep = (ms) => new Promise((res, rej) => setTimeout(res, ms))

// todo: test create double org, app, appv
// todo: test create app version no org no app

function cli(cmd, args, env={}) {
  args = [cmd, ...args]
  args = args.join(' ')
  return new Promise((res, rej) => {
    exec(args, { env }, (error, stdout, stderr) => {
      if (error) { return rej(new Error(`cli error ${error.code} ${stderr}`)) }
      const data = stdout.trim()
      res(data)
    })
  })
}

const org_id = `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`
const dev_id = `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`

const dev_key = `BYZmO9MAQCVyJZmkTBGJ9bYeeGuR1yp2wNt7x4hYlQf+zvAT2dcwA3XjT52qcCqqneO98LiBPJQopAfwO3OkWA==`
const dev_key_pub = `/s7wE9nXMAN140+dqnAqqp3jvfC4gTyUKKQH8DtzpFg=`

let org = null
let dev = null

test('create org and dev', async (t) => {
  const cmd = '/app/helper-key-server.sh'
  const args = [`--create-org test1 --org-id ${org_id} --dev-id ${dev_id} --dev-email dev1@dev1 --dev-key-pub ${dev_key_pub} --target ${TARGET}`]
  const env = { ADMIN_KEY }
  let out = await cli(cmd, args, env)
  console.log(123, out)

  out = JSON.parse(out)
  org = out.org
  dev = out.dev

  t.equal(org.id, org_id, 'org id')
  t.equal(org.name, 'test1', 'org name')
  t.equal(typeof org.attest_secret, 'string', 'org attest_secret')
  t.equal(org.created_by, dev_id, 'org created_by')
  t.equal(typeof org.created_at, 'number', 'org created_at')

  t.equal(dev.id, dev_id, 'dev id')
  t.equal(dev.email, 'dev1@dev1', 'dev email')
  t.equal(dev.key_pub, dev_key_pub, 'dev key pub')
  t.equal(typeof dev.created_at, 'number', 'dev created_at')
  t.end()
})

let app = null

test('create app', async (t) => {
  const cmd = '/app/helper-key-server.sh'
  const args = [`--create-app testapp1 --org-id ${org_id} --dev-id ${dev_id} --target ${TARGET}`]
  const env = { DEV_KEY: dev_key }
  const out = await cli(cmd, args, env)
  console.log(456, out)

  app = JSON.parse(out)
  t.equal(typeof app.id, 'string', 'app id')
  t.equal(app.name, 'testapp1', 'app name')
  t.equal(app.org_id, org_id, 'app org_id')
  t.equal(app.created_by, dev_id, 'app created_by')
  t.equal(typeof app.created_at, 'number', 'app created_at')
  t.end()
})

let appv = null
const HASH = process.env.HASH

test('create app version', async (t) => {
  const cmd = '/app/helper-key-server.sh'
  const args = [`--create-app-version testapp1v1 --org-id ${org_id} --dev-id ${dev_id} --app-id ${app.id} --version-pcr ${HASH} --target ${TARGET}`]
  const env = { DEV_KEY: dev_key }
  const out = await cli(cmd, args, env)
  console.log(789, out)

  appv = JSON.parse(out)
  t.equal(typeof appv.id, 'string', 'appv id')
  t.equal(appv.name, 'testapp1v1', 'appv name')
  t.equal(appv.org_id, org_id, 'appv org_id')
  t.equal(appv.app_id, app.id, 'appv app_id')
  t.equal(appv.created_by, dev_id, 'appv created_by')
  t.equal(appv.pcr, HASH, 'appv PCR')
  t.equal(typeof appv.created_at, 'number', 'appv created_at')
  t.end()
})

const rmAppKey = async (name) => {
  const cmd = '/runtime/attest-key-server.sh'
  const args = [`--rm-app-key ${name} --app-id ${app.id} --target ${TARGET}`]
  const env = { ATTEST_SECRET: org.attest_secret }
  return cli(cmd, args, env)
}

test('rm app key', async (t) => {
  const keyName = 'testkey1'
  const out = await rmAppKey(keyName)
  console.log(999, out)

  const key = JSON.parse(out)
  t.equal(key.name, keyName, 'key name')
  t.equal(key.orgId, org_id, 'key orgId')
  t.equal(key.appId, app.id, 'key appId')
  t.equal(key.data, null, 'key data null')
  t.end()
})

test('get app key', async (t) => {
  const keyName = 'testkey1'
  await rmAppKey(keyName)

  const cmd = '/runtime/attest-key-server.sh'
  const args = [`--get-app-key ${keyName} --app-id ${app.id} --target ${TARGET}`]
  const env = { ATTEST_SECRET: org.attest_secret }
  const out = await cli(cmd, args, env)
  console.log(999, out)

  const key = JSON.parse(out)
  t.equal(key.name, keyName, 'key name')
  t.equal(key.orgId, org_id, 'key orgId')
  t.equal(key.appId, app.id, 'key appId')
  t.equal(key.data, null, 'key data null')
  t.end()
})

test('gen app key', async (t) => {
  const keyName = 'testkey1'
  await rmAppKey(keyName)

  const cmd = '/runtime/attest-key-server.sh'
  let args = [`--gen-app-key ${keyName} --app-id ${app.id} --target ${TARGET}`]
  const env = { ATTEST_SECRET: org.attest_secret }
  let out = await cli(cmd, args, env)
  console.log(999, out)

  const key = JSON.parse(out)
  t.equal(key.name, keyName, 'key name')
  t.equal(key.orgId, org_id, 'key orgId')
  t.equal(key.appId, app.id, 'key appId')
  t.equal(typeof key.data, 'string', 'key data')
  const data = Buffer.from(key.data, 'base64')
  t.equal(data.length, 32, 'key data 32')

  // no replace
  args = [`--gen-app-key ${keyName} --app-id ${app.id} --target ${TARGET}`]
  out = await cli(cmd, args, env)
  console.log(999, out)

  const key2 = JSON.parse(out)
  t.equal(key2.name, keyName, 'key name')
  t.equal(key2.orgId, org_id, 'key orgId')
  t.equal(key2.appId, app.id, 'key appId')
  t.equal(typeof key2.data, 'string', 'key data')
  const data2 = Buffer.from(key2.data, 'base64')
  t.equal(data2.length, 32, 'key data 32')
  t.ok(data2.equals(data), 'key data eq')

  // replace
  args = [`--gen-app-key ${keyName} --replace --length 64 --app-id ${app.id} --target ${TARGET}`]
  out = await cli(cmd, args, env)
  console.log(999, out)

  const key3 = JSON.parse(out)
  t.equal(key3.name, keyName, 'key name')
  t.equal(key3.orgId, org_id, 'key orgId')
  t.equal(key3.appId, app.id, 'key appId')
  t.equal(typeof key3.data, 'string', 'key data')
  const data3 = Buffer.from(key3.data, 'base64')
  t.equal(data3.length, 64, 'key data 64')
  t.ok(!data3.equals(data), 'key data not eq')
  t.ok(!data3.equals(data2), 'key data not eq')
  t.end()
})

test('set app key', async (t) => {
  const keyName = 'testkey1'
  await rmAppKey(keyName)

  const cmd = '/runtime/attest-key-server.sh'
  let data = crypto.randomBytes(32).toString('base64')
  let args = [`--set-app-key ${keyName} --key ${data} --app-id ${app.id} --target ${TARGET}`]
  data = Buffer.from(data, 'base64')
  const env = { ATTEST_SECRET: org.attest_secret }
  let out = await cli(cmd, args, env)
  console.log(999, out)

  const key = JSON.parse(out)
  t.equal(key.name, keyName, 'key name')
  t.equal(key.orgId, org_id, 'key orgId')
  t.equal(key.appId, app.id, 'key appId')
  t.equal(typeof key.data, 'string', 'key data')
  let data2 = Buffer.from(key.data, 'base64')
  t.equal(data2.length, 32, 'key data 32')
  t.ok(data2.equals(data), 'key data eq')

  // no replace
  data2 = crypto.randomBytes(32).toString('base64')
  args = [`--set-app-key ${keyName} --key ${data2} --app-id ${app.id} --target ${TARGET}`]
  out = await cli(cmd, args, env)
  console.log(999, out)

  const key2 = JSON.parse(out)
  t.equal(key2.name, keyName, 'key name')
  t.equal(key2.orgId, org_id, 'key orgId')
  t.equal(key2.appId, app.id, 'key appId')
  t.equal(typeof key2.data, 'string', 'key data')
  data2 = Buffer.from(key2.data, 'base64')
  t.equal(data2.length, 32, 'key data 32')
  t.ok(data2.equals(data), 'key data eq')

  // replace
  data2 = crypto.randomBytes(64).toString('base64')
  args = [`--set-app-key ${keyName} --key ${data2} --replace --app-id ${app.id} --target ${TARGET}`]
  data2 = Buffer.from(data2, 'base64')
  out = await cli(cmd, args, env)
  console.log(999, out)

  const key3 = JSON.parse(out)
  t.equal(key3.name, keyName, 'key name')
  t.equal(key3.orgId, org_id, 'key orgId')
  t.equal(key3.appId, app.id, 'key appId')
  t.equal(typeof key3.data, 'string', 'key data')
  const data3 = Buffer.from(key3.data, 'base64')
  t.equal(data3.length, 64, 'key data 64')
  t.ok(data3.equals(data2), 'key data eq')
  t.end()
})

test('get app key bench', async (t) => {
  let begin = null
  const once = async () => {
    begin = Date.now()
    const keyName = 'testkey1'
    const cmd = '/runtime/attest-key-server.sh'
    const args = [`--get-app-key ${keyName} --app-id ${app.id} --target ${TARGET}`]
    const env = { ATTEST_SECRET: org.attest_secret }
    const out = await cli(cmd, args, env)
    const key = JSON.parse(out)
    t.equal(key.name, keyName, 'key name')
    t.equal(key.orgId, org_id, 'key orgId')
    t.equal(key.appId, app.id, 'key appId')
    t.ok(key.data, 'key data ')
    console.log('bench', Date.now() - begin)
  }
  for (let i = 0; i < 10; i++) { await once() }
  t.end()
})

test('gen app key bench', async (t) => {
  let begin = null
  const once = async () => {
    begin = Date.now()
    const keyName = 'testkey1'
    const cmd = '/runtime/attest-key-server.sh'
    const args = [`--gen-app-key ${keyName} --replace --app-id ${app.id} --target ${TARGET}`]
    const env = { ATTEST_SECRET: org.attest_secret }
    const out = await cli(cmd, args, env)
    const key = JSON.parse(out)
    t.equal(key.name, keyName, 'key name')
    t.equal(key.orgId, org_id, 'key orgId')
    t.equal(key.appId, app.id, 'key appId')
    t.ok(key.data, 'key data ')
    console.log('bench', Date.now() - begin)
  }
  for (let i = 0; i < 10; i++) { await once() }
  t.end()
})

test('admin errors', async (t) => {
  const cmd = '/app/helper-key-server.sh'
  const args = [`--create-org test1 --org-id ${org_id} --dev-id ${dev_id} --dev-email dev1@dev1 --dev-key-pub ${dev_key_pub} --target ${TARGET}`]
  const bad = crypto.randomBytes(64).toString('base64')
  const env = { ADMIN_KEY: bad }

  try {
    await cli(cmd, args, env)
    t.fail('no error')
  } catch (err) {
    t.pass('error')
    t.ok(err.message.includes('status 401'), 'error 401')
  }

  t.end()
})

test('dev errors', async (t) => {
  const cmd = '/app/helper-key-server.sh'
  // real dev bad key
  let args = [`--create-app testapp2 --org-id ${org_id} --dev-id ${dev_id} --target ${TARGET}`]
  const bad = crypto.randomBytes(64).toString('base64')
  let env = { DEV_KEY: bad }

  try {
    await cli(cmd, args, env)
    t.fail('no error')
  } catch (err) {
    t.pass('error')
    t.ok(err.message.includes('status 401'), 'error 401')
  }

  // bad dev real key
  const dev2 = new Array(32).fill('c').join('')
  args = [`--create-app testapp2 --org-id ${org_id} --dev-id ${dev2} --target ${TARGET}`]
  env = { DEV_KEY: dev_key }

  try {
    await cli(cmd, args, env)
    t.fail('no error')
  } catch (err) {
    t.pass('error')
    t.ok(err.message.includes('status 401'), 'error 401')
  }

  // bad dev bad key
  args = [`--create-app testapp2 --org-id ${org_id} --dev-id ${dev2} --target ${TARGET}`]
  env = { DEV_KEY: bad }

  try {
    await cli(cmd, args, env)
    t.fail('no error')
  } catch (err) {
    t.pass('error')
    t.ok(err.message.includes('status 401'), 'error 401')
  }

  // real dev bad org real key
  const org2 = new Array(32).fill('c').join('')
  args = [`--create-app testapp2 --org-id ${org2} --dev-id ${dev_id} --target ${TARGET}`]
  env = { DEV_KEY: dev_key }

  try {
    await cli(cmd, args, env)
    t.fail('no error')
  } catch (err) {
    t.pass('error')
    t.ok(err.message.includes('status 403'), 'error 403')
  }

  // bad dev bad org real key
  args = [`--create-app testapp2 --org-id ${org2} --dev-id ${dev2} --target ${TARGET}`]
  env = { DEV_KEY: dev_key }

  try {
    await cli(cmd, args, env)
    t.fail('no error')
  } catch (err) {
    t.pass('error')
    t.ok(err.message.includes('status 401'), 'error 401')
  }

  // bad dev bad org bad key
  args = [`--create-app testapp2 --org-id ${org2} --dev-id ${dev2} --target ${TARGET}`]
  env = { DEV_KEY: bad }

  try {
    await cli(cmd, args, env)
    t.fail('no error')
  } catch (err) {
    t.pass('error')
    t.ok(err.message.includes('status 401'), 'error 401')
  }

  t.end()
})

test('length errors', async (t) => {
  const keyName = 'testkey1'
  const cmd = '/runtime/attest-key-server.sh'
  let args = [`--gen-app-key ${keyName} --length 8 --app-id ${app.id} --target ${TARGET}`]
  const env = { ATTEST_SECRET: org.attest_secret }

  try {
    await cli(cmd, args, env)
    t.fail('no error')
  } catch (err) {
    t.pass('error')
    t.ok(err.message.includes('error --length'), 'error length')
  }

  args = [`--gen-app-key ${keyName} --length 256 --app-id ${app.id} --target ${TARGET}`]
  try {
    await cli(cmd, args, env)
    t.fail('no error')
  } catch (err) {
    t.pass('error')
    t.ok(err.message.includes('error --length'), 'error length')
  }

  let data = crypto.randomBytes(8).toString('base64')
  args = [`--set-app-key ${keyName} --key ${data} --app-id ${app.id} --target ${TARGET}`]
  try {
    await cli(cmd, args, env)
    t.fail('no error')
  } catch (err) {
    t.pass('error')
    t.ok(err.message.includes('error --key'), 'error key')
  }

  data = crypto.randomBytes(256).toString('base64')
  args = [`--set-app-key ${keyName} --key ${data} --app-id ${app.id} --target ${TARGET}`]
  try {
    await cli(cmd, args, env)
    t.fail('no error')
  } catch (err) {
    t.pass('error')
    t.ok(err.message.includes('error --key'), 'error key')
  }

  t.end()
})

test('target errors', async (t) => {
  const csv = fs.readFileSync('/runtime/target.csv', 'utf8')
  const csv1 = csv.split(`\n`).filter((line) => line.trim().length > 0).map((line) => {
    const bad = crypto.randomBytes(32).toString('hex')
    const [target, url, nitroPcr, amiPcr] = line.split(`,`)
    return [target, url, bad, amiPcr].join(',')
  })

  const csv2 = csv.split(`\n`).filter((line) => line.trim().length > 0).map((line) => {
    const bad = crypto.randomBytes(32).toString('hex')
    const [target, url, nitroPcr, amiPcr] = line.split(`,`)
    return [target, url, nitroPcr, bad].join(',')
  })

  // helper-key-server.sh bad pcrs
  const targets = '/runtime/bad.csv'
  fs.writeFileSync(targets, csv1.join(`\n`))
  let cmd = '/app/helper-key-server.sh'
  let args = [`--create-org test1 --org-id ${org_id} --dev-id ${dev_id} --dev-email dev1@dev1 --dev-key-pub ${dev_key_pub} --target ${TARGET} --target-csv ${targets}`]
  let env = { ADMIN_KEY }

  try {
    await cli(cmd, args, env)
    t.fail('no error')
  } catch (err) {
    t.pass('error')
    t.ok(err.message.includes('Nitro PCR does not match'), 'error nitro pcr')
  }

  fs.writeFileSync(targets, csv2.join(`\n`))

  try {
    await cli(cmd, args, env)
    t.fail('no error')
  } catch (err) {
    t.pass('error')
    t.ok(err.message.includes('AMI PCR does not match'), 'error ami pcr')
  }

  // attest-key-server.sh bad pcrs
  fs.writeFileSync(targets, csv1.join(`\n`))
  cmd = '/runtime/attest-key-server.sh'
  const keyName = 'testkey1'
  args = [`--get-app-key ${keyName} --app-id ${app.id} --target ${TARGET} --target-csv ${targets} --reset`]
  env = { ATTEST_SECRET: org.attest_secret }

  try {
    await cli(cmd, args, env)
    t.fail('no error')
  } catch (err) {
    t.pass('error')
    t.ok(err.message.includes('Nitro PCR does not match'), 'error nitro pcr')
  }

  fs.writeFileSync(targets, csv2.join(`\n`))

  try {
    await cli(cmd, args, env)
    t.fail('no error')
  } catch (err) {
    t.pass('error')
    t.ok(err.message.includes('AMI PCR does not match'), 'error ami pcr')
  }

  t.end()
})

test('target not found errors', async (t) => {
  let cmd = '/app/helper-key-server.sh'
  let args = [`--create-org test1 --org-id ${org_id} --dev-id ${dev_id} --dev-email dev1@dev1 --dev-key-pub ${dev_key_pub} --target notfound1`]
  let env = { ADMIN_KEY }

  try {
    await cli(cmd, args, env)
    t.fail('no error')
  } catch (err) {
    t.pass('error')
    t.ok(err.message.includes('target csv no notfound1'), 'error target not found')
  }

  cmd = '/runtime/attest-key-server.sh'
  const keyName = 'testkey1'
  args = [`--get-app-key ${keyName} --app-id ${app.id} --target notfound1`]
  env = { ATTEST_SECRET: org.attest_secret }

  try {
    await cli(cmd, args, env)
    t.fail('no error')
  } catch (err) {
    t.pass('error')
    t.ok(err.message.includes('target csv no notfound1'), 'error target not found')
  }

  t.end()
})

test('attest errors', async (t) => {
  // real app bad secret
  const cmd = '/runtime/attest-key-server.sh'
  const keyName = 'testkey1'
  let args = [`--get-app-key ${keyName} --app-id ${app.id} --target ${TARGET} --reset`]
  let bad = crypto.randomBytes(32).toString('hex')
  let env = { ATTEST_SECRET: bad }

  try {
    await cli(cmd, args, env)
    t.fail('no error')
  } catch (err) {
    t.pass('error')
    t.ok(err.message.includes('server says attest secret is not correct'), 'error secret')
  }

  // bad app bad secret
  const app2 = new Array(32).fill('c').join('')
  args = [`--get-app-key ${keyName} --app-id ${app2} --target ${TARGET} --reset`]
  env = { ATTEST_SECRET: bad }

  try {
    await cli(cmd, args, env)
    t.fail('no error')
  } catch (err) {
    t.pass('error')
    t.ok(err.message.includes('server sent error'), 'error server')
    t.ok(err.message.includes(`No app (${app2}) with PCR`), 'error server pcr')
  }

  // bad app real secret
  args = [`--get-app-key ${keyName} --app-id ${app2} --target ${TARGET} --reset`]
  env = { ATTEST_SECRET: org.attest_secret }

  try {
    await cli(cmd, args, env)
    t.fail('no error')
  } catch (err) {
    t.pass('error')
    t.ok(err.message.includes('server sent error'), 'error server')
    t.ok(err.message.includes(`No app (${app2}) with PCR`), 'error server pcr')
  }

  // bad hash real app real secret
  bad = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync('/hash.txt', bad)
  args = [`--get-app-key ${keyName} --app-id ${app.id} --target ${TARGET} --reset`]
  env = { ATTEST_SECRET: org.attest_secret }

  try {
    await cli(cmd, args, env)
    t.fail('no error')
  } catch (err) {
    t.pass('error')
    t.ok(err.message.includes('server sent error'), 'error server')
    t.ok(err.message.includes(`No app (${app.id}) with PCR`), 'error server pcr')
  }

  t.end()
})
