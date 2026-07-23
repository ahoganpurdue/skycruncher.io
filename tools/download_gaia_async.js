import https from 'https';
import fs from 'fs';
import { URLSearchParams } from 'url';

const query = `
SELECT 
    source_id, ra, dec, phot_g_mean_mag, bp_rp, pmra, pmdec
FROM gaiadr3.gaia_source
WHERE phot_g_mean_mag < 12.5 
  AND bp_rp IS NOT NULL 
  AND pmra IS NOT NULL 
  AND pmdec IS NOT NULL
`;

const postData = new URLSearchParams({
    REQUEST: 'doQuery',
    LANG: 'ADQL',
    FORMAT: 'csv',
    QUERY: query
}).toString();

async function makeRequest(urlStr, options, postBody, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await new Promise((resolve, reject) => {
                const req = https.request(urlStr, options, (res) => {
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        resolve({ status: res.statusCode, location: res.headers.location });
                        return;
                    }
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => resolve({ status: res.statusCode, data }));
                });
                req.on('error', reject);
                if (postBody) req.write(postBody);
                req.end();
            });
        } catch (err) {
            console.error(`Request failed (${err.code}). Retrying ${i+1}/${retries}...`);
            await delay(2000);
            if (i === retries - 1) throw err;
        }
    }
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runAsyncJob() {
    console.log("Submitting ASYNC ADQL Query to ESA Gaia Archive...");
    
    // 1. Submit Job
    const submitRes = await makeRequest('https://gea.esac.esa.int/tap-server/tap/async', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData)
        }
    }, postData);

    if (submitRes.status !== 303 || !submitRes.location) {
        console.error("Failed to submit job. Status:", submitRes.status);
        console.error(submitRes.data);
        return;
    }

    const jobUrl = submitRes.location;
    console.log(`Job Created at: ${jobUrl}`);

    // 2. Start Job
    console.log("Starting job...");
    const phaseData = new URLSearchParams({ PHASE: 'RUN' }).toString();
    const startRes = await makeRequest(jobUrl + '/phase', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(phaseData)
        }
    }, phaseData);
    
    // 3. Poll for completion
    let phase = '';
    while (phase !== 'COMPLETED' && phase !== 'ERROR') {
        await delay(5000); // 5 sec poll
        const res = await makeRequest(jobUrl + '/phase', { method: 'GET' });
        phase = res.data.trim();
        console.log(`Job Phase: ${phase}`);
    }

    if (phase === 'ERROR') {
         console.error("Job Failed!");
         const errRes = await makeRequest(jobUrl + '/error', { method: 'GET' });
         console.error(errRes.data);
         return;
    }

    // 4. Download Results
    console.log("Job Completed! Downloading results to gaia_vanguard_dr3.csv...");
    const resultUrl = jobUrl + '/results/result';
    
    return new Promise((resolve, reject) => {
        const download = () => {
             https.get(resultUrl, (res) => {
                 const file = fs.createWriteStream("gaia_vanguard_dr3.csv");
                 res.pipe(file);
                 file.on('finish', () => {
                     file.close();
                     console.log("Download complete. File saved as 'gaia_vanguard_dr3.csv'. Ready for SkyCruncher ingestion.");
                     resolve();
                 });
            }).on('error', (e) => {
                 console.error(`Download failed: ${e.message}. Retrying stream...`);
                 setTimeout(download, 3000);
            });
        };
        download();
    });
}

runAsyncJob().catch(console.error);
