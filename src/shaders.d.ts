// Module declarations for non-standard imports used by the pipeline

// WGSL shader files imported as raw strings via Vite's ?raw suffix
declare module '*.wgsl?raw' {
    const content: string;
    export default content;
}

declare module '*.wgsl' {
    const content: string;
    export default content;
}

