const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { convertMod } = require('./converter');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const app = express();
const port = 3000;

// Setup directories
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const WORK_DIR = path.join(__dirname, 'work');

fs.ensureDirSync(UPLOADS_DIR);
fs.ensureDirSync(DOWNLOADS_DIR);
fs.ensureDirSync(WORK_DIR);

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Static file serving
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/downloads', express.static(DOWNLOADS_DIR));

// Serve HTML files
app.get('/', (req, res) => {
    res.redirect('/index_de.html');
});
app.get('/index.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/index_de.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'index_de.html'));
});

// Setup multer for file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, UPLOADS_DIR);
    },
    filename: function (req, file, cb) {
        cb(null, uuidv4() + '.zip');
    }
});
const upload = multer({ storage: storage });

// API: Upload file
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
    }
    // Return local URL identifier
    res.json({ url: 'local:' + req.file.filename });
});

// Store tasks in memory
const tasks = {};

// API: Convert
app.post('/api/convert', async (req, res) => {
    let url = req.body.url;
    const lang = req.body.lang || 'en';
    const taskId = uuidv4();
    
    tasks[taskId] = {
        status: 101,
        message: lang === 'de' ? 'Starte Konvertierung...' : 'Starting conversion...',
        progress: 0
    };

    res.json({ status: 200, message: taskId });

    // Process asynchronously
    try {
        let zipPath = '';
        if (url.startsWith('local:')) {
            // It's an uploaded file
            zipPath = path.join(UPLOADS_DIR, url.split(':')[1]);
        } else if (url.startsWith('http')) {
            // Stealth Download via Puppeteer
            tasks[taskId].message = lang === 'de' ? 'Lade Mod herunter...' : 'Downloading mod...';
            tasks[taskId].progress = 10;
            
            const launchOptions = {
                headless: 'new',
                args: [
                    '--no-sandbox', 
                    '--disable-setuid-sandbox', 
                    '--disable-dev-shm-usage',
                    '--disable-blink-features=AutomationControlled',
                    '--window-size=1920,1080'
                ]
            };
            if (process.env.PUPPETEER_EXECUTABLE_PATH) {
                launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
            }
            const browser = await puppeteer.launch(launchOptions);
            
            try {
                const page = await browser.newPage();
                
                // Set realistic viewport and user agent
                await page.setViewport({ width: 1920, height: 1080 });
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                
                // Hide webdriver flag
                await page.evaluateOnNewDocument(() => {
                    Object.defineProperty(navigator, 'webdriver', { get: () => false });
                });

                const downloadPath = path.join(WORK_DIR, taskId, 'temp_dl');
                fs.mkdirSync(downloadPath, { recursive: true });

                const client = await page.target().createCDPSession();
                await client.send('Page.setDownloadBehavior', {
                    behavior: 'allow',
                    downloadPath: downloadPath,
                });

                console.log(`[${taskId}] Navigating to: ${url}`);
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
                await new Promise(r => setTimeout(r, 3000));
                
                tasks[taskId].message = lang === 'de' ? 'Download wird vorbereitet...' : 'Preparing download...';
                tasks[taskId].progress = 20;

                if (url.includes('gta5-mods.com')) {
                    // GTA5-Mods has a 2-click download: first click goes to download page, second click starts actual download
                    const btnSelector = 'a.btn-download';
                    try {
                        // Click 1: Go to the download page
                        await page.waitForSelector(btnSelector, { timeout: 15000 });
                        console.log(`[${taskId}] Clicking first download button...`);
                        await Promise.all([
                            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
                            page.evaluate((sel) => document.querySelector(sel).click(), btnSelector)
                        ]);
                        await new Promise(r => setTimeout(r, 3000));
                        
                        tasks[taskId].message = lang === 'de' ? 'Datei wird heruntergeladen...' : 'Downloading file...';
                        tasks[taskId].progress = 30;
                        
                        // Click 2: Start the actual file download
                        await page.waitForSelector(btnSelector, { timeout: 15000 });
                        console.log(`[${taskId}] Clicking second download button...`);
                        await page.evaluate((sel) => document.querySelector(sel).click(), btnSelector);
                        
                    } catch (e) {
                        console.log(`[${taskId}] Download button click issue:`, e.message);
                        // Try alternative: look for any download link
                        try {
                            const dlLink = await page.evaluate(() => {
                                const links = document.querySelectorAll('a[href*="/download/"]');
                                return links.length > 0 ? links[links.length - 1].href : null;
                            });
                            if (dlLink) {
                                console.log(`[${taskId}] Trying alternative download link: ${dlLink}`);
                                await page.goto(dlLink, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
                                await new Promise(r => setTimeout(r, 2000));
                                // Try clicking download button on the new page
                                try {
                                    await page.waitForSelector(btnSelector, { timeout: 5000 });
                                    await page.evaluate((sel) => document.querySelector(sel).click(), btnSelector);
                                } catch (e2) { /* ignore */ }
                            }
                        } catch (e2) {
                            console.log(`[${taskId}] Alternative download also failed:`, e2.message);
                        }
                    }
                }
                
                // Wait for file download to complete (up to 120 seconds)
                let downloadedFile = null;
                console.log(`[${taskId}] Waiting for download to finish...`);
                for (let i = 0; i < 120; i++) {
                    await new Promise(r => setTimeout(r, 1000));
                    let files;
                    try {
                        files = fs.readdirSync(downloadPath);
                    } catch(e) { continue; }
                    
                    if (files.length > 0) {
                        // Find completed downloads (not .crdownload temp files)
                        const completed = files.filter(f => !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
                        if (completed.length > 0) {
                            downloadedFile = path.join(downloadPath, completed[0]);
                            console.log(`[${taskId}] Download complete: ${completed[0]}`);
                            break;
                        }
                        // Update progress while downloading
                        if (i % 5 === 0) {
                            tasks[taskId].message = lang === 'de' 
                                ? `Datei wird heruntergeladen... (${i}s)` 
                                : `Downloading file... (${i}s)`;
                            tasks[taskId].progress = 30 + Math.min(i, 40);
                        }
                    }
                }
                
                if (!downloadedFile) {
                    throw new Error(lang === 'de' 
                        ? "Download-Timeout nach 120 Sekunden. Bitte versuche es mit Datei-Upload." 
                        : "Download timeout after 120 seconds. Please try file upload.");
                }
                // RPF extraction is handled by converter.js after ZIP is extracted
                zipPath = downloadedFile;
            } catch (err) {
                throw new Error((lang === 'de' ? "Fehler beim Herunterladen: " : "Download error: ") + err.message);
            } finally {
                await browser.close();
            }
        } else {
            throw new Error(lang === 'de' ? 'Keine Datei oder Link angegeben' : 'No file or link provided');
        }

        // Start conversion
        tasks[taskId].message = lang === 'de' ? 'Dateien werden verpackt...' : 'Extracting and processing files...';
        tasks[taskId].progress = 50;

        const resultFile = await convertMod(zipPath, taskId, WORK_DIR, DOWNLOADS_DIR);

        tasks[taskId] = {
            status: 200,
            message: lang === 'de' ? 'Konvertierung abgeschlossen, Datei verpackt.' : 'Conversion complete, file packaged.',
            name: path.basename(resultFile),
            file: `downloads/${path.basename(resultFile)}`,
            progress: 100
        };

    } catch (err) {
        console.error("Task failed:", err);
        tasks[taskId] = {
            status: 500,
            message: (lang === 'de' ? 'Fehler: ' : 'Error: ') + err.message
        };
    }
});

// API: Query status
app.post('/api/query', (req, res) => {
    const uuid = req.body.uuid;
    if (tasks[uuid]) {
        res.json(tasks[uuid]);
    } else {
        res.json({ status: 404, message: 'Task not found' });
    }
});

app.listen(port, () => {
    console.log(`Judie Mod Converter Backend running at http://localhost:${port}`);
});
