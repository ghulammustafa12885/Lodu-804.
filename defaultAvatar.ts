// High-fidelity Imran Khan vector portrait with PTI Green & Red sash/muffler & 804 insignia
export const DEFAULT_IK_AVATAR = `data:image/svg+xml;utf8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#028A0F" />
      <stop offset="50%" stop-color="#064E3B" />
      <stop offset="100%" stop-color="#DC2626" />
    </linearGradient>
    <linearGradient id="skinGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#FDDCB5" />
      <stop offset="100%" stop-color="#E1A976" />
    </linearGradient>
    <linearGradient id="hairGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#4B5563" />
      <stop offset="50%" stop-color="#27272A" />
      <stop offset="100%" stop-color="#09090B" />
    </linearGradient>
    <linearGradient id="mufflerPTI" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#028A0F" />
      <stop offset="50%" stop-color="#10B981" />
      <stop offset="51%" stop-color="#EF4444" />
      <stop offset="100%" stop-color="#B91C1C" />
    </linearGradient>
    <linearGradient id="gold804" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#FDE047" />
      <stop offset="50%" stop-color="#EAB308" />
      <stop offset="100%" stop-color="#CA8A04" />
    </linearGradient>
  </defs>

  <!-- Circular Base -->
  <circle cx="100" cy="100" r="98" fill="url(#bgGrad)" stroke="#EAB308" stroke-width="4"/>
  
  <!-- Subtle Stadium Aura -->
  <circle cx="100" cy="100" r="90" fill="none" stroke="#FFFFFF" stroke-opacity="0.15" stroke-dasharray="6,4"/>

  <!-- Torso & Kurta -->
  <path d="M 40 190 C 42 155 70 142 100 142 C 130 142 158 155 160 190 Z" fill="#18181B" />
  <path d="M 75 145 L 100 178 L 125 145 Z" fill="#27272A" />

  <!-- Iconic PTI Muffler / Scarf (Green & Red) -->
  <path d="M 52 165 C 65 140 85 136 100 138 C 115 136 135 140 148 165 C 138 185 132 195 130 200 L 110 200 L 100 162 L 90 200 L 70 200 C 68 195 62 185 52 165 Z" fill="url(#mufflerPTI)" stroke="#09090B" stroke-width="2"/>

  <!-- Neck -->
  <path d="M 85 118 L 85 145 C 92 150 108 150 115 145 L 115 118 Z" fill="url(#skinGrad)"/>

  <!-- Face -->
  <path d="M 66 85 C 66 122 78 142 100 142 C 122 142 134 122 134 85 C 134 60 120 48 100 48 C 80 48 66 60 66 85 Z" fill="url(#skinGrad)" />

  <!-- Ears -->
  <ellipse cx="65" cy="90" rx="6" ry="12" fill="#E1A976" />
  <ellipse cx="135" cy="90" rx="6" ry="12" fill="#E1A976" />

  <!-- Flowing Charismatic Hair -->
  <path d="M 58 84 C 54 62 68 40 88 34 C 104 29 122 32 136 40 C 146 48 148 65 144 82 C 140 68 135 52 120 47 C 105 42 85 46 76 56 C 68 64 64 74 58 84 Z" fill="url(#hairGrad)" />
  <path d="M 58 84 C 62 76 72 70 82 66 C 75 74 70 85 68 95 C 64 92 60 88 58 84 Z" fill="#27272A" />

  <!-- Classic Sunglasses / Aviators -->
  <path d="M 74 78 Q 88 78 98 84 L 98 86 Q 88 98 74 96 Q 66 94 68 85 Q 70 78 74 78 Z" fill="#18181B" stroke="#EAB308" stroke-width="2.5"/>
  <path d="M 126 78 Q 112 78 102 84 L 102 86 Q 112 98 126 96 Q 134 94 132 85 Q 130 78 126 78 Z" fill="#18181B" stroke="#EAB308" stroke-width="2.5"/>
  <!-- Glasses Bridge -->
  <path d="M 97 83 Q 100 81 103 83" fill="none" stroke="#EAB308" stroke-width="3" />
  <!-- Lens reflection -->
  <line x1="74" y1="82" x2="84" y2="92" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-opacity="0.6"/>
  <line x1="116" y1="82" x2="126" y2="92" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-opacity="0.6"/>

  <!-- Determined Nose & Jaw Line -->
  <path d="M 100 90 L 98 108 L 104 108" fill="none" stroke="#C98852" stroke-width="2.5" stroke-linecap="round" />
  <path d="M 88 122 C 94 126 106 126 112 122" fill="none" stroke="#9A3412" stroke-width="2.5" stroke-linecap="round"/>

  <!-- 804 Gold Chest Badge -->
  <g transform="translate(100, 172)">
    <rect x="-24" y="-10" width="48" height="20" rx="5" fill="#09090B" stroke="url(#gold804)" stroke-width="1.8"/>
    <text x="0" y="5" font-family="'Impact', 'Arial Black', sans-serif" font-weight="900" font-size="13" fill="url(#gold804)" text-anchor="middle" letter-spacing="1">804</text>
  </g>
</svg>
`)}`;

export function processImageUpload(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('No file selected'));
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        // Compress image to 200x200 max for speedy multi-device sync
        const canvas = document.createElement('canvas');
        const size = Math.min(img.width, img.height);
        canvas.width = 160;
        canvas.height = 160;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(e.target?.result as string);
          return;
        }
        // Center crop square
        const sx = (img.width - size) / 2;
        const sy = (img.height - size) / 2;
        ctx.drawImage(img, sx, sy, size, size, 0, 0, 160, 160);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = () => resolve(e.target?.result as string);
      img.src = e.target?.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
