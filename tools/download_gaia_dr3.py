from astroquery.gaia import Gaia
import time

# Define the ADQL query matching the Vanguard Spec
query = """
SELECT 
    source_id, ra, dec, phot_g_mean_mag, bp_rp, pmra, pmdec
FROM gaiadr3.gaia_source
WHERE phot_g_mean_mag < 12.5 
  AND bp_rp IS NOT NULL 
  AND pmra IS NOT NULL 
  AND pmdec IS NOT NULL
"""

print("Submitting query to ESA Gaia Archive...")
start_time = time.time()

# Launch an asynchronous job (required for large queries)
job = Gaia.launch_job_async(query, dump_to_file=True, output_format="csv", output_file="gaia_vanguard_dr3.csv")

print(f"Download complete in {time.time() - start_time:.2f} seconds.")
print(f"File saved as 'gaia_vanguard_dr3.csv'. Ready for SkyCruncher ingestion.")
