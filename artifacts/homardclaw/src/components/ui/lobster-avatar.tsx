import React, { useState, useEffect } from 'react';

// Generates an original pixel art lobster avatar based on agent status and properties
export function LobsterAvatar({ 
  size = 64, 
  status = 'idle',
  primaryColor = '#ff4500', // primary
  secondaryColor = '#00ffff' // accent
}: { 
  size?: number;
  status?: 'idle' | 'working' | 'researching' | 'waiting' | 'paused' | 'error' | 'queued' | 'complete';
  primaryColor?: string;
  secondaryColor?: string;
}) {
  const [frame, setFrame] = useState(0);
  
  // Simple animation loop
  useEffect(() => {
    if (status === 'paused' || status === 'error' || status === 'idle' || status === 'queued') return;
    
    const interval = setInterval(() => {
      setFrame(f => (f + 1) % 2);
    }, status === 'working' ? 400 : 800);
    
    return () => clearInterval(interval);
  }, [status]);

  // SVG-based pixel art generation
  // We use rects for crisp pixels to avoid anti-aliasing issues
  
  const renderPixel = (x: number, y: number, color: string) => {
    return <rect x={x} y={y} width="1" height="1" fill={color} key={`${x}-${y}-${pixels.length}`} />;
  };

  const getEyes = () => {
    if (status === 'error') return 'x';
    if (status === 'waiting') return 'sleep';
    if (status === 'researching') return 'glasses';
    if (status === 'working') return 'focused';
    return 'normal';
  };

  const eyeType = getEyes();
  const isAnimating = frame === 1;
  const darkEdge = '#1a1b26'; // Match background
  const clawColor = status === 'working' ? secondaryColor : primaryColor;
  
  // 16x16 grid
  const pixels: React.ReactElement[] = [];
  
  // Body (Lobster)
  const drawRect = (startX: number, startY: number, w: number, h: number, color: string) => {
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        pixels.push(renderPixel(startX + x, startY + y, color));
      }
    }
  };

  // Base silhouette (claws up or down based on animation)
  const clawY = (isAnimating || status === 'waiting') ? 3 : 2;
  
  // Left Claw
  drawRect(2, clawY, 3, 4, clawColor);
  drawRect(3, clawY+4, 1, 3, primaryColor); // arm
  
  // Right Claw
  drawRect(11, clawY, 3, 4, clawColor);
  drawRect(12, clawY+4, 1, 3, primaryColor); // arm

  // Antennae
  drawRect(6, 1, 1, 3, primaryColor);
  drawRect(9, 1, 1, 3, primaryColor);

  // Main Body
  drawRect(5, 4, 6, 8, primaryColor);
  
  // Tail
  drawRect(4, 12, 8, 3, primaryColor);
  drawRect(3, 14, 10, 1, primaryColor); // tail fan

  // Eyes
  const eyeColor = '#ffffff';
  const pupilColor = '#000000';
  
  if (eyeType === 'x') {
    // X eyes
    drawRect(6, 5, 1, 1, pupilColor);
    drawRect(7, 6, 1, 1, pupilColor);
    drawRect(6, 7, 1, 1, pupilColor);
    
    drawRect(9, 5, 1, 1, pupilColor);
    drawRect(8, 6, 1, 1, pupilColor);
    drawRect(9, 7, 1, 1, pupilColor);
  } else if (eyeType === 'sleep') {
    drawRect(6, 6, 2, 1, pupilColor);
    drawRect(8, 6, 2, 1, pupilColor);
  } else if (eyeType === 'glasses') {
    drawRect(5, 5, 3, 2, secondaryColor);
    drawRect(8, 5, 3, 2, secondaryColor);
    drawRect(6, 5, 1, 1, pupilColor);
    drawRect(9, 5, 1, 1, pupilColor);
  } else {
    // Normal / focused
    drawRect(6, 5, 2, 2, eyeColor);
    drawRect(8, 5, 2, 2, eyeColor);
    // pupils look forward or side based on animation
    const px = isAnimating ? 7 : 6;
    drawRect(px, 6, 1, 1, pupilColor);
    drawRect(px+2, 6, 1, 1, pupilColor);
  }

  // Accessories / Desk (Context)
  if (status === 'working' || status === 'researching') {
    // Tiny computer monitor
    drawRect(3, 10, 10, 5, '#333333'); // monitor bezel
    drawRect(4, 11, 8, 3, secondaryColor); // screen glow
    if (isAnimating) {
      drawRect(5, 12, 2, 1, '#ffffff'); // code on screen
      drawRect(5, 13, 4, 1, '#ffffff');
    } else {
      drawRect(5, 11, 3, 1, '#ffffff');
      drawRect(5, 12, 5, 1, '#ffffff');
    }
  }

  return (
    <svg 
      width={size} 
      height={size} 
      viewBox="0 0 16 16" 
      shapeRendering="crispEdges"
      className="pixelated"
      style={{ imageRendering: 'pixelated' }}
    >
      <rect width="16" height="16" fill="transparent" />
      {pixels}
    </svg>
  );
}
