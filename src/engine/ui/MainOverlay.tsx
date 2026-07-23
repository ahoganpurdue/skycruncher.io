import React, { useState, useMemo } from 'react';
import './styles/Symbols.css';
import { 
  computeOverlayStars, 
  mapOverlayToJPEG, 
  OverlayStar
} from '../web/components/OverlayEngine';
import { PlateSolution } from '../types/Main_types';
import { ImageDimensions, ScaleMetadata } from '../types/schema';

interface MainOverlayProps {
  solution: PlateSolution;
  rawDimensions: ImageDimensions;
  displayDimensions: ImageDimensions;
  scales?: ScaleMetadata;
  onStarClick?: (star: OverlayStar) => void;
}

/**
 * ASTRO_OVERLAY
 * Projects the J2000 plate solution onto the current JPEG/PNG display area.
 */
export function MainOverlay({ solution, rawDimensions, displayDimensions, scales, onStarClick }: MainOverlayProps) {
  const [hoverStar, setHoverStar] = useState<OverlayStar | null>(null);

  // 1. Compute which stars should be visible
  const stars = useMemo(() => {
    if (!solution || rawDimensions.width === 0) return [];
    return computeOverlayStars(solution, 25);
  }, [solution, rawDimensions]);

  // 2. Map those stars from "Raw Pixel Space" to "Browser Display Space"
  const mappedStars = useMemo(() => {
    if (!stars.length) return [];
    return mapOverlayToJPEG(
      stars,
      rawDimensions,
      displayDimensions
    );
  }, [stars, rawDimensions, displayDimensions]);

  if (!solution) return null;

  return (
    <div className="main-overlay-container">
      <svg 
        width={displayDimensions.width} 
        height={displayDimensions.height}
        className="overlay-svg"
      >
        {mappedStars.map((star, idx) => {
            const isHovered = hoverStar?.name === star.name;
            return (
              <g 
                key={`${star.name}_${idx}`}
                onMouseEnter={() => setHoverStar(star)}
                onMouseLeave={() => setHoverStar(null)}
                onClick={() => onStarClick?.(star)}
                className={`star-group ${isHovered ? 'hovered' : ''}`}
              >
                {/* Outer Glow */}
                {star.magnitude < 2 && (
                  <circle 
                    cx={star.x} 
                    cy={star.y} 
                    r={star.markerRadius + (isHovered ? 6 : 4)} 
                    className={star.isPlanet ? "glow-planet" : "glow-star"}
                  />
                )}

                {/* Main Marker */}
                <circle 
                  cx={star.x} 
                  cy={star.y} 
                  r={star.markerRadius} 
                  className={`marker-circle ${star.isPlanet ? 'planet' : 'star'}`}
                />

                {/* Label (Brighter stars or hovered) */}
                {(star.magnitude < 3.5 || isHovered) && (
                  <text
                    x={star.x + star.markerRadius + 4}
                    y={star.y + 4}
                    className={`star-label ${star.isPlanet ? 'planet' : 'star'} ${isHovered ? 'bold' : ''}`}
                  >
                    {star.name}
                  </text>
                )}
              </g>
            );
        })}
      </svg>

      {hoverStar && (
        <StarTooltip star={hoverStar} scales={scales} displayDimensions={displayDimensions} />
      )}

      <style>{`
        .main-overlay-container {
           position: absolute;
           top: 0; left: 0;
           width: 100%; height: 100%;
           pointer-events: none;
        }
        .overlay-svg { pointer-events: auto; }
        .star-group { cursor: pointer; }
        .star-label {
           pointer-events: none;
           text-shadow: 0 0 4px rgba(0,0,0,0.8);
           font-family: 'Inter', sans-serif;
           font-size: 10px;
        }
        .star-label.star { fill: var(--sc-text); }
        .star-label.planet { fill: var(--sc-accent); }
        .star-label.bold { font-weight: bold; }

        .glow-star { fill: color-mix(in srgb, var(--sc-text) 10%, transparent); }
        .glow-planet { fill: color-mix(in srgb, var(--sc-accent) 20%, transparent); }

        .marker-circle { stroke-width: 1; }
        .marker-circle.star { fill: var(--sc-text); stroke: color-mix(in srgb, var(--sc-text) 50%, transparent); }
        .marker-circle.planet { fill: var(--sc-accent); stroke: color-mix(in srgb, var(--sc-text) 50%, transparent); }

        .star-group.hovered .marker-circle { stroke: var(--sc-text); stroke-width: 2; filter: drop-shadow(0 0 4px var(--sc-text)); }

        .star-tooltip {
          position: absolute;
          background: var(--sc-panel);
          border: 1px solid var(--sc-line-strong);
          border-radius: 4px;
          padding: 8px;
          color: var(--sc-text);
          font-size: 11px;
          z-index: 1000;
          box-shadow: 0 4px 20px rgba(0,0,0,0.5);
          pointer-events: none;
          backdrop-filter: blur(4px);
          min-width: 120px;
        }
        .tooltip-header {
           font-weight: bold;
           border-bottom: 1px solid var(--sc-line-subtle);
           padding-bottom: 4px;
           margin-bottom: 4px;
        }
        .tooltip-header.planet { color: var(--sc-accent); }
        .tooltip-grid {
           display: grid;
           grid-template-columns: 1fr 1fr;
           gap: 4px;
        }
        .tooltip-label { opacity: 0.6; }
      `}</style>
    </div>
  );
}

function StarTooltip({ star, scales, displayDimensions }: { star: OverlayStar, scales?: ScaleMetadata, displayDimensions: ImageDimensions }) {
  const left = Math.min(star.x + 15, displayDimensions.width - 150);
  const top = Math.min(star.y + 15, displayDimensions.height - 100);

  return (
    <div 
      className="star-tooltip"
      style={{ left, top }}
    >
      <div className={`tooltip-header ${star.isPlanet ? 'planet' : ''}`}>
        <span className={star.isPlanet ? "icon-planet" : "icon-star"}></span>
        {star.name}
      </div>
      <div className="tooltip-grid">
        <span className="tooltip-label">Mag:</span> <span>{star.magnitude.toFixed(1)}</span>
        <span className="tooltip-label">RA:</span> <span>{star.ra.toFixed(3)}h</span>
        <span className="tooltip-label">Dec:</span> <span>{star.dec.toFixed(3)}<span className="icon-degree"></span></span>
      </div>
    </div>
  );
}
