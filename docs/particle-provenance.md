# Hero particle provenance

## Source supplied by the user

- Source file: user-supplied `video-site-replica/dist/particles.js`
- SHA-256: `0b9fc501b2fda31624c4d7b4c316f04a186e5836f0bd4cb67c4e5ed14d79e61d`
- Source status: supplied by the user as the visual reference for this project
- License metadata: no license file was present with the supplied source during this implementation; its license remains unknown, and this note records provenance without making a licensing claim

## Reused implementation ideas

`assets/js/hero-particles.js` adapts the reference's low-level WebGL point renderer, deterministic linear congruential random generator, interleaved particle buffer, damped spring return, pointer repulsion, expanding ripple band, burst velocity, theme palette, device-pixel-ratio cap, and 2D canvas fallback.

The shader structure and the spring/ripple equations retain the same technical approach. Variable names, lifecycle, data layout, counts, sizing rules, title sampling, events, accessibility behavior, and public API were rewritten for this site.

## Deliberate removals and changes

- Removed full-viewport sizing, document-wide scene selectors, overlay canvas, chapter transitions, progress state, forms, cards, labels, keyboard behavior, and source-specific UI dependencies.
- Removed the source title and product references. The module renders the local `Alcedo` title using the separately managed Instrument Serif font.
- All coordinates now come from the hero canvas client rectangle, so the effect remains inside `.hero-stage`.
- Particle budgets are deterministic: 13,000 on desktop, 4,500 on mobile, and at most 1,800 for the Canvas 2D fallback. Five percent form a low-opacity ambient layer; the rest sample the title at one-pixel intervals.
- Added `IntersectionObserver`, page visibility suspension, `ResizeObserver`, live `data-theme` synchronization, reduced-motion static rendering, and complete listener/observer cleanup.
- The animation loop suspends after spring motion settles and wakes only for pointer input, ripples, bursts, resize, theme changes, or lifecycle restoration. Waves remain active until their visible ripple finishes.
- WebGL setup failure or context loss keeps `.particle-fallback` visible. The parent receives `.is-ready` only after a canvas frame is drawn successfully.
- Touch pointer handlers are passive and never prevent scrolling.

## Font licensing

The user-supplied particle source and the site's fonts have separate provenance. Instrument Serif and the self-hosted Noto Serif KR Korean WOFF2 subsets include their own SIL Open Font License 1.1 texts in `static/fonts/`. The Noto Serif KR subsets provide full Korean coverage through Unicode-ranged, variable-weight WOFF2 files obtained from Google Fonts. Those font licenses do not establish a license for the particle source.

## Public API

```js
const particles = new HeroParticles(canvas, {
  title: 'Alcedo',
  fontFamily: 'Instrument',
});

particles.start();
particles.pause();
particles.resize();
particles.setTheme('ink'); // or 'paper'
particles.burst();
particles.setReducedMotion(true);
particles.metrics; // { renderer, count, fps, running, reduced }
particles.destroy();
```
