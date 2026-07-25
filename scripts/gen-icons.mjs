// Renders public/logo.svg into the PNG icon sizes browsers and phones need.
// Run once after changing the logo: node scripts/gen-icons.mjs
import sharp from 'sharp'
import { readFileSync } from 'node:fs'

const svg = readFileSync('public/logo.svg')
const out = [
  ['public/favicon-32.png', 32],
  ['public/apple-touch-icon.png', 180],
  ['public/icon-192.png', 192],
  ['public/icon-512.png', 512],
]
for (const [file, size] of out) {
  await sharp(svg, { density: 72 * (size / 64) }).resize(size, size).png().toFile(file)
  console.log(`${file} (${size}px)`)
}
