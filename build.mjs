import fs from 'fs';
import path from 'path';
import archiver from 'archiver';

function errorUsage() {
  console.log('Usage: node build.mjs [bingchat|optisearch] [--v2] [-cp <build dir>] [-z <output zip file>] [--clean]');
  process.exit(1);
}

(async function main() {
  let pathManifestV3 = '';
  let name = 'OptiSearch';
  if(process.argv.includes('bingchat'))
    name = 'BingChat';
  else if(process.argv.includes('bard'))
    name = 'Bard';

  if (name === 'BingChat')
    pathManifestV3 = 'manifest_bingchat.json';
  else if (name === 'Bard')
    pathManifestV3 = 'manifest_bard.json';
  else
    pathManifestV3 = 'manifest_optisearch.json';
  
  const v = process.argv.includes('--v2') ? 2 : 3;
  buildManifest(pathManifestV3, v);
  console.log(`${name} manifest v${v} created`);

  const mf = readJsonFile('manifest.json');

  if (fs.existsSync('_locales'))
    fs.rmSync('_locales', { recursive: true });
  if (mf.default_locale){
    makeLocalesDir(`src/locales/${name.toLowerCase()}.json`)
  }

  let buildDir = 'build';
  if (process.argv.includes('-cp')) {
    const nextArgv = process.argv[process.argv.indexOf('-cp') + 1];
    if (nextArgv && !nextArgv.startsWith('-')) {
      buildDir = nextArgv;
    }
  }

  if (process.argv.includes('-cp') || process.argv.includes('-z')) {
    copyToBuildDir(buildDir);
    console.log(`Source copied to "${buildDir}" directory`);
  }

  if (process.argv.includes('-z')) {
    const nextArgv = process.argv[process.argv.indexOf('-z') + 1];
    let out = `versions/${name}_${mf.version}${mf.manifest_version === 2 ? '_firefox' : ''}.zip`;
    if (nextArgv && !nextArgv.startsWith('-')) {
      out = nextArgv;
    }
    await zipDir(buildDir, out);
    console.log(`Extension zipped into "${out}"`);
  }

  if (process.argv.includes('--clean')) {
    fs.rmSync(buildDir, { recursive: true });
    console.log(`Directory "${buildDir}" cleaned`);
  }

  console.log();
})();


/**
 * Builds the manifest.json file from a manifest file in version 3.
 * This function does not exhaustively copy all possible fields.
 * @param {string} pathManifestV3 Path to the manifest file in version 3.
 * @param {2|3} version 2 or 3.
 */
function buildManifest(pathManifestV3, version = 3) {
  if (version === 3) {
    fs.copyFileSync(pathManifestV3, 'manifest.json');
    return;
  }

  const mfv3 = readJsonFile(pathManifestV3);
  const mfv2 = { manifest_version: 2 };
  const fields = ['name', 'version', 'description', 'default_locale', 'author', 'icons',
    'background', 'content_scripts'];

  fields.forEach(f => {
    if (!(f in mfv3))
      return;
    mfv2[f] = mfv3[f];
  });

  if ('action' in mfv3) {
    mfv2['browser_action'] = mfv3['action'];
  }
  if ('background' in mfv3) {
    mfv2['background'] = { scripts: [mfv3['background']['service_worker']] };
  }

  if ('permissions' in mfv3) {
    mfv2['permissions'] = [];
    const permissions = mfv2['permissions'];
    mfv3['permissions'].forEach(p => {
      if (p.startsWith('declarativeNetRequest')) {
        !permissions.includes('webRequest') && permissions.push('webRequest');
        !permissions.includes('webRequestBlocking') && permissions.push('webRequestBlocking');
      } else {
        permissions.push(p);
      }
    });
  }

  if ('host_permissions' in mfv3) {
    mfv2['permissions'] ??= [];
    mfv2['permissions'] = [...mfv2['permissions'], ...mfv3['host_permissions']];
  }

  if ('declarative_net_request' in mfv3) {
    mfv2['background'] ??= { scripts: [] };
    mfv3['declarative_net_request']['rule_resources'].forEach(rules => {
      // switch to the .js rule instead of the .json
      mfv2['background']['scripts'].push(rules['path'].slice(0, -2));
    });
  }

  if ('web_accessible_resources' in mfv3) {
    mfv2['web_accessible_resources'] = [];
    mfv3['web_accessible_resources'].forEach(war => {
      mfv2['web_accessible_resources'] = [...mfv2['web_accessible_resources'], ...war['resources']];
    });
  }

  // Write the version 2 manifest file
  fs.writeFileSync('manifest.json', JSON.stringify(mfv2, null, 4));
}

/**
 * Parse files from manifest.json and copy them to the build folder.
 * @param {string} buildDir 
 */
function copyToBuildDir(buildDir = 'build/') {
  const mf = readJsonFile('manifest.json');

  // get content script js and web-accessible resources
  const contentScripts = mf['content_scripts'];
  let scripts = [];
  for (let cs of contentScripts) {
    scripts = scripts.concat(cs['js']);
  }

  let resources = [];
  for (let res of mf['web_accessible_resources']) {
    if (typeof res === 'object') {
      resources = resources.concat(res['resources']);
    } else {
      resources.push(res);
    }
  }

  let popupHtml = '';
  if ('action' in mf) {
    popupHtml = mf['action']['default_popup'];
  } else if ('browser_action' in mf) {
    popupHtml = mf['browser_action']['default_popup'];
  }

  let files = [];
  if ('background' in mf) {
    if ('service_worker' in mf['background']) {
      files.push(mf['background']['service_worker']);
    } else if ('scripts' in mf['background']) {
      files = files.concat(mf['background']['scripts']);
    }
  }

  files = files.concat(scripts);

  if ('declarative_net_request' in mf) {
    for (let r of mf['declarative_net_request']['rule_resources']) {
      files.push(r['path']);
    }
  }

  files = files.concat(Object.values(mf['icons']));

  // loop in resources and add them to files, if one is directory, add all files in it
  for (let resource of resources) {
    if (resource.slice(-1) === '*' && fs.lstatSync(resource.slice(0, -1)).isDirectory()) {
      const dir = resource.slice(0, -1);
      for (let file of fs.readdirSync(dir)) {
        files.push(path.join(dir, file));
      }
    } else {
      files.push(resource);
    }
  }

  // get parent dir of popupHtml
  const popupParentDir = path.dirname(popupHtml);

  // add popupParentDir files to files
  for (let file of fs.readdirSync(popupParentDir)) {
    files.push(path.join(popupParentDir, file));
  }

  if (buildDir.slice(-1) !== '/') {
    buildDir += '/';
  }
  // delete all files in src folder
  if (fs.existsSync(buildDir))
    fs.rmSync(buildDir, { recursive: true });
  fs.mkdirSync(buildDir, { recursive: true });

  // copy files to src folder, conserve the folder structure, creates directory based on the path of the file
  fs.copyFileSync('manifest.json', path.join(buildDir, 'manifest.json'));
  if(fs.existsSync('_locales'))
    copyDir('_locales', path.join(buildDir, '_locales'));
  fs.mkdirSync(path.join(buildDir, 'src'));

  for (let file of files) {
    const directory = path.join(buildDir, path.dirname(file));
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }
    const filename = path.basename(file);
    fs.copyFileSync(file, path.join(directory, filename));
  }
}

function makeLocalesDir(localesFile) {
  fs.mkdirSync('_locales');
  const json = readJsonFile(localesFile);
  const locales = {};
  for (let [key, types] of Object.entries(json)) {
    for (let [lang, value] of Object.entries(types.message)) {
      locales[lang] ??= {};
      locales[lang][key] = value;
    }
  }
  Object.entries(locales).forEach(([lang, entries]) => {
    fs.mkdirSync(`_locales/${lang}`);
    const jsonToSave = {};
    for (let [key, value] of Object.entries(entries)) {
      jsonToSave[key] = { "message": value };
    }
    fs.writeFileSync(`_locales/${lang}/messages.json`, JSON.stringify(jsonToSave, null, 4));
  })
}

function readJsonFile(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}


/**
 * Copy a directory recursively
 * @param {string} src 
 * @param {string} dest 
 */
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (let entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function zipDir(dir, out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const output = fs.createWriteStream(out);
  const archive = archiver('zip', {
    zlib: { level: 9 },
  });
  archive.pipe(output);
  archive.directory(dir, false);
  await archive.finalize();
}