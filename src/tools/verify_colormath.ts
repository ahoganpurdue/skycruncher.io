
import { planckianLocus } from '../engine/core/colormath';

console.log("Testing Colormath...");
try {
    const locus = planckianLocus(10);
    console.log("Locus generated:", locus.length);
    console.log("Sample:", locus[0]);
} catch (e: any) {
    console.error("Colormath failed:", e.message);
}

