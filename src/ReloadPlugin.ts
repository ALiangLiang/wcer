import * as fs from "fs"
import Server from "./socketServer"
import {info, error} from "./logger"
import {merge, template} from "lodash"
import AbstractPlugin from "./abstractPlugin"
import {ConcatSource} from "webpack-sources"
import {requirePath} from "./tools"
import client from "raw-loader!./client.ts"

let chunkVersions: object = {}
let manifestTimestamp: number

export default class ReloadPlugin extends AbstractPlugin {
  private port: number
  private server: Server | null = null
  private manifest: Manifest
  private manifestPath: string
  constructor({port, manifest}: Options) {
    super();
    this.port = port || 9090 
    this.manifestPath = manifest || null
  }
  sourceFactory(...sources): Source {
    return new ConcatSource(...sources)
  } 
  watcher (comp) {
    if(!this.server && this.manifestPath) {
      this.server = new Server(this.port)
    }
    return comp
  }
  compile (comp) {
    try {
      this.manifest = requirePath(`${this.manifestPath}`)
    } catch(err) {
      error((<Error>err).message)
    }
  }
  injector(comp, chunks) {
    let WSHost =  `ws://localhost:${this.port}/`
    if(!this.server || !this.manifest) return false;
    let {background} = this.manifest;
    let assets = chunks.reduce((res, chunk) => {
      let [filename] = chunk.files;
      if (/\.js$/.test(filename)) {
        let source = template(client)({
          filename, 
          id: chunk.id,
          name: chunk.name || null,
          WSHost
        })
        res[filename] = this.sourceFactory(source, comp.assets[filename])
      }
      return res
    }, {})
    if(!background ||!(background.page || background.scripts)) {
      let scripts: string ='background.reload.js';
      let source = template(client)({
        filename: [scripts],
        id: '-1',
        name: scripts,
        WSHost
      })
      this.manifest.background = {scripts:[scripts], persistent: false}
      assets[scripts] = { 
        source: () => source, 
        size: () => source.length 
      }
    }
    comp.assets = Object.assign({}, comp.assets, assets)
  }
  triggered (comp) {
    if(!this.server || !this.manifest) return comp;
    let { content_scripts, background } = this.manifest;
    let scripts = background.scripts ? background.scripts : [];
    if(content_scripts && content_scripts.length) {
      content_scripts.forEach(content => scripts = scripts.concat(content.js));
    }
    info(' Starting the Chrome Hot Plugin Reload Server...')
    comp.chunks.forEach(function(chunk, name) {
      var hash = chunkVersions[chunk.name];
      chunkVersions[chunk.name] = chunk.hash;
      if(chunk.hash !== hash ) {
        let changed = chunk.files.filter( file => scripts.indexOf(file) !== -1)
        if(changed.length) {
          this.server.signRestart()
        } else {
          this.server.signReload(chunk.id, chunk.id)
        }
      }
    }.bind(this))
  
    let manifest = comp.fileTimestamps[this.manifestPath]
    if ((manifestTimestamp || 1) < (manifest || Infinity)) {
      manifestTimestamp = Date.now();
      console.log('manifestTimestamp')
      this.server.signRestart()
    }
    return comp
  }
  generate(comp) {
    if(!this.manifest) return comp
    // comp.fileDependencies.push(this.manifestPath)
    // form https://github.com/wheeljs
    const {fileDependencies} = comp;
    if (fileDependencies instanceof Set) {
      fileDependencies.add(this.manifestPath)
    } else {
      fileDependencies.push(this.manifestPath)
    }
    let source = JSON.stringify(this.manifest)
    comp.assets['manifest.json'] = {
      source: () => source,
      size: () => source.length
    }
    return comp
  }
  apply(compiler) { 
    compiler.hooks.watchRun.tap("ReloadPlugin", (comp) => this.watcher(comp))
    compiler.hooks.compile.tap("ReloadPlugin", (comp) => this.compile(comp))
    compiler.hooks.compilation.tap('ReloadPlugin',
    (comp) => comp.hooks.afterOptimizeChunkAssets.tap('ReloadPlugin',
      (chunks) => this.injector(comp, chunks)))
    compiler.hooks.afterEmit.tap('ReloadPlugin', (comp) => this.triggered(comp))
    compiler.hooks.emit.tap('ReloadPlugin', (comp) => this.generate(comp))
  }
}