const fs = require('fs-extra');
const path = require('path');
const AdmZip = require('adm-zip');
const { v4: uuidv4 } = require('uuid');
const { execSync } = require('child_process');
const unrar = require('node-unrar-js');

async function extractArchive(archivePath, targetDir) {
    const ext = path.extname(archivePath).toLowerCase();
    if (ext === '.rar') {
        const buf = Uint8Array.from(fs.readFileSync(archivePath));
        const extractor = await unrar.createExtractorFromData({ data: buf });
        const { files } = extractor.extract({ files: () => true });

        for (const file of files) {
            if (!file.fileHeader.flags.directory) {
                const outPath = path.join(targetDir, file.fileHeader.name);
                fs.ensureDirSync(path.dirname(outPath));
                fs.writeFileSync(outPath, file.extraction);
            }
        }
    } else {
        const zip = new AdmZip(archivePath);
        zip.extractAllTo(targetDir, true);
    }
}

const RPF_CLI = path.join(__dirname, 'rpf-cli.exe');

// Recursively extract all .rpf files in a directory
function extractAllRpf(dir, outputBase) {
    const items = fs.readdirSync(dir);
    for (const item of items) {
        const itemPath = path.join(dir, item);
        if (fs.statSync(itemPath).isDirectory()) {
            extractAllRpf(itemPath, outputBase);
        } else if (path.extname(item).toLowerCase() === '.rpf') {
            const rpfOut = path.join(outputBase, path.basename(item, '.rpf') + '_rpf_extracted');
            fs.ensureDirSync(rpfOut);
            try {
                const isWin = process.platform === 'win32';
                const cmd = isWin 
                    ? `"${RPF_CLI}" extract "${itemPath}" -o "${rpfOut}"`
                    : `wine "${RPF_CLI}" extract "${itemPath}" -o "${rpfOut}"`;
                execSync(cmd, { stdio: 'pipe' });
                console.log(`  [RPF] Extracted: ${item}`);
                // Recursively extract nested rpf files
                extractAllRpf(rpfOut, outputBase);
            } catch (e) {
                console.log(`  [RPF] Could not extract ${item}: ${e.message}`);
            }
        }
    }
}

// Collect all files recursively from a directory
function getFilesRecursively(dir) {
    const results = [];
    if (!fs.existsSync(dir)) return results;
    const items = fs.readdirSync(dir);
    for (const item of items) {
        const itemPath = path.join(dir, item);
        if (fs.statSync(itemPath).isDirectory()) {
            results.push(...getFilesRecursively(itemPath));
        } else {
            results.push(itemPath);
        }
    }
    return results;
}

async function convertMod(zipPath, taskId, workDir, downloadsDir) {
    const extractDir = path.join(workDir, taskId, 'extracted');
    const rpfExtractDir = path.join(workDir, taskId, 'rpf_extracted');
    const outputDir = path.join(workDir, taskId, 'output');
    const streamDir = path.join(outputDir, 'stream');
    const commonDir = path.join(outputDir, 'common');
    
    fs.ensureDirSync(extractDir);
    fs.ensureDirSync(rpfExtractDir);
    fs.ensureDirSync(streamDir);
    fs.ensureDirSync(commonDir);

    // Step 1: Extract archive (supports zip, rar, 7z)
    try {
        await extractArchive(zipPath, extractDir);
    } catch (e) {
        throw new Error("Invalid archive file or corrupted archive: " + e.message);
    }

    // Step 2: Find and extract all .rpf files recursively
    console.log(`[${taskId}] Checking for .rpf files...`);
    extractAllRpf(extractDir, rpfExtractDir);

    // Step 3: Collect ALL files from both extracted zip AND extracted rpf dirs
    const allFiles = [
        ...getFilesRecursively(extractDir),
        ...getFilesRecursively(rpfExtractDir)
    ];

    const metaFiles = [];
    let hasModels = false;

    for (const file of allFiles) {
        const ext = path.extname(file).toLowerCase();
        const baseName = path.basename(file).toLowerCase();

        // 3D Models and Textures -> stream/
        if (ext === '.yft' || ext === '.ytd' || ext === '.ydr' || ext === '.ybn') {
            fs.copySync(file, path.join(streamDir, path.basename(file)));
            hasModels = true;
        }
        
        // Meta data files -> common/
        if (ext === '.meta') {
            if (baseName.includes('vehicles') || 
                baseName.includes('carcols') || 
                baseName.includes('handling') || 
                baseName.includes('carvariations') ||
                baseName.includes('dlctext') ||
                baseName.includes('vehicleweapons') ||
                baseName.includes('weaponarchetypes') ||
                baseName.includes('caraddoncontentunlocks') ||
                baseName.includes('vehiclelayouts')) {
                fs.copySync(file, path.join(commonDir, path.basename(file)));
                if (!metaFiles.includes(path.basename(file))) {
                    metaFiles.push(path.basename(file));
                }
            }
        }
    }

    if (!hasModels) {
        throw new Error("No vehicle models (.yft, .ytd) found in the archive.");
    }

    // Step 4: Generate fxmanifest.lua
    let manifest = `fx_version 'cerulean'\ngames { 'gta5' }\n\nfiles {\n`;
    
    for (const meta of metaFiles) {
        manifest += `\t'common/${meta}',\n`;
    }
    manifest += `\t'common/*.meta'\n}\n`;

    for (const meta of metaFiles) {
        const lowerMeta = meta.toLowerCase();
        if (lowerMeta.includes('vehicleweapons')) {
            manifest += `data_file 'WEAPONINFO_FILE' 'common/${meta}'\n`;
        } else if (lowerMeta.includes('weaponarchetypes')) {
            manifest += `data_file 'WEAPON_METADATA_FILE' 'common/${meta}'\n`;
        } else if (lowerMeta.includes('dlctext')) {
            manifest += `data_file 'DLCTEXT_FILE' 'common/${meta}'\n`;
        } else if (lowerMeta.includes('vehiclelayouts')) {
            manifest += `data_file 'VEHICLE_LAYOUTS_FILE' 'common/${meta}'\n`;
        } else if (lowerMeta.includes('handling')) {
            manifest += `data_file 'HANDLING_FILE' 'common/${meta}'\n`;
        } else if (lowerMeta.includes('vehicles')) {
            manifest += `data_file 'VEHICLE_METADATA_FILE' 'common/${meta}'\n`;
        } else if (lowerMeta.includes('carcols')) {
            manifest += `data_file 'CARCOLS_FILE' 'common/${meta}'\n`;
        } else if (lowerMeta.includes('carvariations')) {
            manifest += `data_file 'VEHICLE_VARIATION_FILE' 'common/${meta}'\n`;
        } else if (lowerMeta.includes('caraddoncontentunlocks')) {
            manifest += `data_file 'CONTENT_UNLOCKING_META_FILE' 'common/${meta}'\n`;
        }
    }

    fs.writeFileSync(path.join(outputDir, 'fxmanifest.lua'), manifest);

    // Step 5: Create final zip
    const outZip = new AdmZip();
    outZip.addLocalFolder(outputDir);
    const finalZipName = taskId + '-fivem-ready.zip';
    const finalZipPath = path.join(downloadsDir, finalZipName);
    outZip.writeZip(finalZipPath);

    // Cleanup work dir for this task
    fs.removeSync(path.join(workDir, taskId));

    return finalZipPath;
}

module.exports = { convertMod };
