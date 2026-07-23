import https from 'https';
import fs from 'fs';

const query = `SELECT source_id, ra, dec, phot_g_mean_mag, bp_rp, pmra, pmdec FROM gaiadr3.gaia_source WHERE phot_g_mean_mag < 12.5 AND bp_rp IS NOT NULL AND pmra IS NOT NULL AND pmdec IS NOT NULL`;

const postData = new URLSearchParams({
    REQUEST: 'doQuery',
    LANG: 'ADQL',
    FORMAT: 'csv',
    QUERY: query
}).toString();

const options = {
    hostname: 'gea.esac.esa.int',
    port: 443,
    path: '/tap-server/tap/sync',
    method: 'POST',
    headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
    }
};

console.log("Submitting ADQL Query to ESA Gaia Archive (Sync mode)...");
const req = https.request(options, (res) => {
    console.log(`STATUS: ${res.statusCode}`);
    if (res.statusCode !== 200) {
        let errorData = '';
        res.on('data', chunk => errorData += chunk);
        res.on('end', () => console.error("Error from Gaia:", errorData));
        return;
    }
    const file = fs.createWriteStream("gaia_vanguard_dr3.csv");
    res.pipe(file);
    file.on('finish', () => {
        console.log("Finished downloading gaia_vanguard_dr3.csv");
        file.close();
    });
});

req.on('error', (e) => {
    console.error(`Problem with request: ${e.message}`);
});

req.write(postData);
req.end();
