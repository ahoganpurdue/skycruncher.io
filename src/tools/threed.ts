/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * SIMPLE SOFTWARE 3D ENGINE
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * 
 * A lightweight 3D projection engine for rendering wireframes on a 2D canvas.
 * No WebGL, just good old fashioned math.
 */

export interface Point3D {
    x: number;
    y: number;
    z: number;
}

export interface Camera {
    theta: number; // Angle around Y axis (Horizontal)
    phi: number;   // Angle around X axis (Vertical)
    dist: number;  // distance from center
}

// Standard Isomorphic View
export const DEFAULT_CAMERA: Camera = {
    theta: Math.PI / 4,
    phi: Math.PI / 6,
    dist: 1000
};

/**
 * Projects a 3D point onto a 2D plane using weak perspective projection.
 */
export function project(
    p: Point3D, 
    camera: Camera, 
    center: { x: number, y: number },
    scale: number = 1
): { x: number, y: number, depth: number } {
    // 1. Rotate Point
    // Rotate around Y axis (Theta)
    const x1 = p.x * Math.cos(camera.theta) - p.z * Math.sin(camera.theta);
    const z1 = p.x * Math.sin(camera.theta) + p.z * Math.cos(camera.theta);
    
    // Rotate around X axis (Phi)
    const y2 = p.y * Math.cos(camera.phi) - z1 * Math.sin(camera.phi);
    const z2 = p.y * Math.sin(camera.phi) + z1 * Math.cos(camera.phi);
    
    // 2. Apply Camera distance (Perspective)
    // Simple weak perspective: scale based on Z depth
    const perspective = (camera.dist) / (camera.dist + z2);
    
    return {
        x: center.x + x1 * scale * perspective,
        y: center.y - y2 * scale * perspective, // Flip Y for canvas
        depth: z2
    };
}

/**
 * Rotates a camera based on mouse movement (pixels).
 */
export function orbitCamera(
    camera: Camera, 
    dx: number, 
    dy: number
): Camera {
    return {
        ...camera,
        theta: camera.theta - dx * 0.01,
        phi: Math.max(-Math.PI/2, Math.min(Math.PI/2, camera.phi - dy * 0.01)),
        dist: camera.dist
    };
}

