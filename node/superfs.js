const split = require('split')
const { mkdirp } = require('mkdirp')
const spawn = require('child_process').spawn

module.exports = async function mount(namespace, path, psqlUrl, secret, errCb) {
  await mkdirp(path)
  let logs = ``

  const wrapPid = (proc) => {
    return new Promise((res, rej) => {
      proc.once('error', rej)
      if (proc.pid) { res(proc) }
      rej(new Error('no proc pid'))
    })
  }

  const wrapErrors = (proc) => {
    proc.once('exit', (code) => errCb(new Error(`ssfs exit ${code} ${logs}`)))
    proc.on('error', (err) => errCb(new Error(`ssfs error ${err.message} ${logs}`)))
    proc.stderr.on('error', (err) => errCb(new Error(`ssfs stderr error ${err.message} ${logs}`)))
    proc.stdout.on('error', (err) => errCb(new Error(`ssfs stdout error ${err.message} ${logs}`)))
    proc.stderr.once('end', () => errCb(new Error(`ssfs stderr end ${logs}`)))
    proc.stdout.once('end', () => errCb(new Error(`ssfs stdout end ${logs}`)))
    return proc
  }

  const args = [namespace, path, '--pattern', 'db-journal,db', '--pattern', 'lock,off,log']
  const stdio = ['pipe', 'pipe', 'pipe']
  const env = {}
  env['RUST_BACKTRACE'] = '1'
  env['psql_url'] = psqlUrl
  env['encryption_pass'] = secret
  const proc = spawn('/bin/sqlitesuperfs', args, { stdio, env, cwd: '/app' })

  return new Promise((res, rej) => {
    wrapPid(proc).then((proc) => {
      const log = (line) => {
        line = line.trim()
        if (!line) { return }
        logs += `${line}\n`
        if (line !== 'mounted') { return }
        setTimeout(res, 500)
      }
      proc.stderr.setEncoding('utf8')
      proc.stdout.setEncoding('utf8')
      proc.stderr.pipe(split()).on('data', log)
      proc.stdout.pipe(split()).on('data', log)
      return wrapErrors(proc)
    }).catch(rej)
  })
}
