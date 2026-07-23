
// utils/geocode.ts

export async function getCoordinatesFromCity(cityQuery: string): Promise<{ lat: number, lon: number } | null> {
  try {
    // Nominatim is OpenStreetMap's search engine. It requires a User-Agent header (use your app name).
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cityQuery)}&format=json&limit=1`;
    
    // Note: 'fetch' is browser-native, but ensuring User-Agent is set is polite policy for OSM.
    // In browser, the User-Agent header is controlled by the browser, but we try to set it anyway.
    const response = await fetch(url, {
      // mode: 'cors', // Default is usually fine
    });

    if (!response.ok) {
        throw new Error(`Geocoding error: ${response.statusText}`);
    }

    const data = await response.json();

    if (data && data.length > 0) {
      return {
        lat: parseFloat(data[0].lat),
        lon: parseFloat(data[0].lon)
      };
    }
    return null;
    return null;
  } catch (error) {
    console.error("Geocoding failed:", error);
    return null;
  }
}

export async function getCityFromCoords(lat: number, lon: number): Promise<string | null> {
    try {
        const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`;
        const response = await fetch(url, {
             headers: {
                 'User-Agent': 'SkyCruncher/1.0'
             }
        });
        
        if (!response.ok) return null;
        
        const data = await response.json();
        if (data && data.address) {
            return data.address.city || data.address.town || data.address.village || "Unknown Location";
        }
        return null;
    } catch (e) {
        console.warn("Reverse geocode failed", e);
        return null;
    }
}

