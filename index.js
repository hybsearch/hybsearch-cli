#!/usr/bin/env node

'use strict'

const meow = require('meow')
const got = require('got')
const WebSocket = require('ws')
const prettyMs = require('pretty-ms')
const fs = require('fs')
const path = require('path')
const mkdir = require('make-dir')

const updateNotifier = require('update-notifier')
const pkg = require('./package.json')

// notify the user when updates are available
updateNotifier({pkg}).notify()

function args() {
  let args = meow({
    help: `
      Usage
        $ hybsearch [--server|--thing3] [--pipeline=mbnb] [--outDir] <file.gb>

      Arguments

        <file.gb|file.fasta>   An input file, either in GenBank or FASTA format.

      Options
        --server       A Hybsearch server URL (defaults to thing3.cs.stolaf.edu:80)
        --thing3       Sets --server to thing3.cs.stolaf.edu:80
        --thing3-dev   Sets --server to thing3.cs.stolaf.edu:81
        --localhost    Sets --server to localhost:8080

        --pipeline     Picks a pipeline from the server (defaults to "mbnb")

        --out-dir      Where to save the results of each step. If omitted, results
                       are not saved to the local machine.
    `,
    flags: {
      server: {
        type: 'string',
        default: 'thing3.cs.stolaf.edu:80',
      },
      thing3Dev: {
        type: 'boolean',
        default: false,
      },
      thing3: {
        type: 'boolean',
        default: false,
      },
      localhost: {
        type: 'boolean',
        default: false,
      },

      pipeline: {
        type: 'string',
        default: 'mbnb',
      },

      outDir: {
        type: 'string',
      },
    },
  })

  if (args.flags.thing3) {
    args.flags.server = 'thing3.cs.stolaf.edu:80'
  } else if (args.flags.thing3Dev) {
    args.flags.server = 'thing3.cs.stolaf.edu:81'
  } else if (args.flags.localhost) {
    args.flags.server = 'localhost:8080'
  }

  return args
}

async function initSocket(url) {
  return new Promise((resolve, reject) => {
    let wsUrl = `ws://${url}`
    let socket = new WebSocket(wsUrl)

    socket.addEventListener('open', async () => {
      resolve(socket)
    })
    socket.addEventListener('error', reject)

    return socket
  })
}

function onMessage(packet, outDir, argv) {
  let { type, payload } = JSON.parse(packet)

  if (type === 'stage-start') {
    const { stage } = payload
    console.log(`${stage}: start`)
  } else if (type === 'stage-complete') {
    const { stage, timeTaken, result, cached } = payload
    console.log(`${stage}: completed in ${prettyMs(timeTaken)}${cached ? ' (cached)' : ''}`)

    if (outDir) {
      if (typeof result === 'string') {
        fs.writeFileSync(path.join(outDir, stage), result + '\n', 'utf-8')
      } else {
        fs.writeFileSync(path.join(outDir, stage), JSON.stringify(result, null, '\t') + '\n', 'utf-8')
      }
    }
  } else if (type === 'error') {
    let { error } = payload
    console.error(error)
    socket.close()
  } else if (type === 'exit') {
    console.info('server exited')
    socket.close()
  } else {
    console.warn(`unknown cmd "${type}"`)
  }
}

let socket

async function main() {
  let argv = args()

  let {server, outDir, pipeline} = argv.flags
  let [file] = argv.input

  console.log('connecting to', server, 'to run', pipeline)

  socket = await initSocket(server)

  try {
    console.log('connected to', server)

    let httpUrl = `http://${server}`
    let [uptime, pipelines] = await Promise.all([
      got(`${httpUrl}/uptime`, {json: true}).then(r => r.body.uptime),
      got(`${httpUrl}/pipelines`, {json: true}).then(r => r.body.pipelines),
    ])

    console.log('server uptime:', prettyMs(uptime))

    if (!pipelines.includes(pipeline)) {
      throw new Error(`${server} does not understand the pipeline "${pipeline}"`)
    }

    let data = fs.readFileSync(file, 'utf-8')

    let destDir = outDir ? path.join(outDir, path.basename(file)) : null
    if (destDir) {
      await mkdir(destDir)
    }

    socket.addEventListener('message', packet => onMessage(packet.data, destDir, argv))

    let payload = { type: 'start', pipeline, filepath: file, data }
    socket.send(JSON.stringify(payload), err => {
      if (err) {
        console.error('server error', err)
      }
    })
  } catch (e) {
    socket.close()
    throw e
  }
}

main()
