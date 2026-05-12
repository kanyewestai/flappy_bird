(function () {
  "use strict";

  const WIDTH = 400;
  const HEIGHT = 600;

  const GRAVITY = 0.38;
  const FLAP = -7.2;
  const MAX_VY = 9;

  const BIRD_X = 100;
  /** Draw/hitbox size (sprite is square PNG scaled uniformly). */
  const BIRD_W = 64;
  const BIRD_H = 64;
  /** Shrinks collision vs sprite so grazing clips count less. */
  const HIT_INSET = 12;

  /** On-screen width for pipe.png (tall asset scales down to this width per segment). */
  const PIPE_W = 112;
  /** Pipe solids use a smaller hitbox than the draw rect (forgiving gap). */
  const PIPE_SIDE_INSET = 11;
  const PIPE_GAP_SOFT = 14;
  /** Vertical gap between pipes varies per pair (bird must fit comfortably). */
  const GAP_H_MIN = 118;
  const GAP_H_MAX = 158;
  const PIPE_SPEED = 2.6;
  /** Horizontal distance before the next pipe pair spawns (varies per pair). */
  const PIPE_SPACING_MIN = 210;
  const PIPE_SPACING_MAX = 290;
  const PIPE_MIN_MARGIN = 96;

  /** Coin sprite on-screen size (square); collision radius is half. */
  const COIN_DRAW_SIZE = 36;
  const COIN_R = COIN_DRAW_SIZE / 2;
  /** Skip coin if the gap is too tight to fit one cleanly. */
  const COIN_MIN_GAP = 54;
  /** Vertical bob (px peak); collision matches this motion. */
  const COIN_BOB_AMPLITUDE = Math.max(6, COIN_R * 0.48);
  /** Radians per second for sine bob (lower = slower, smoother cycles). */
  const COIN_BOB_SPEED = 1.85;

  /** Game-over dead sprite bob (visual only; matches ready idle rhythm). */
  const DEAD_BOB_AMPLITUDE = 14;
  const DEAD_BOB_SCALE = 0.0031;

  const BEST_COINS_STORAGE_KEY = "flappyBibiBestCoins";

  function loadBestCoins() {
    try {
      const raw = localStorage.getItem(BEST_COINS_STORAGE_KEY);
      const n = raw == null ? 0 : parseInt(raw, 10);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch (err) {
      return 0;
    }
  }

  function saveBestCoins(n) {
    try {
      localStorage.setItem(BEST_COINS_STORAGE_KEY, String(n));
    } catch (err) {
      /* ignore quota / private mode */
    }
  }

  const canvas = document.getElementById("game");
  const ctx =
    canvas.getContext("2d", {
      alpha: false,
      desynchronized: true,
    }) || canvas.getContext("2d");
  const scoreEl = document.getElementById("score");
  const finalCoinsEl = document.getElementById("final-coins");
  const overlayStart = document.getElementById("overlay-start");
  const overlayGameover = document.getElementById("overlay-gameover");

  let dpr = 1;
  /** Touch / narrow viewports: cheaper canvas (lower DPR, lighter HUD FX). */
  let canvasLite = false;
  let state = "ready";
  let score = 0;
  let coins = 0;
  let bestCoins = loadBestCoins();
  /** Horizontal scroll distance; background tiles scroll left with pipes while playing. */
  let bgScroll = 0;

  const bgImg = new Image();
  let bgReady = false;
  bgImg.onload = function () {
    bgReady = true;
  };
  bgImg.src = "background.png";

  const birdImg = new Image();
  let birdReady = false;
  birdImg.onload = function () {
    birdReady = true;
    if (birdImg.decode) {
      birdImg.decode().catch(function () {});
    }
  };
  birdImg.src = "bird.png";

  const deadImg = new Image();
  let deadReady = false;
  deadImg.onload = function () {
    deadReady = true;
  };
  deadImg.src = "dead.png";

  const pipeImg = new Image();
  let pipeReady = false;
  pipeImg.onload = function () {
    pipeReady = true;
  };
  pipeImg.src = "pipe.png?v=2";

  const coinImg = new Image();
  let coinReady = false;
  coinImg.onload = function () {
    coinReady = true;
  };
  coinImg.src = "coin.png";

  const bird = {
    x: BIRD_X,
    y: HEIGHT / 2,
    vy: 0,
  };

  /** @type {{ x: number; gapY: number; gapH: number; spacingAfter: number; scored: boolean; hasCoin: boolean; coinCollected: boolean; coinPhase: number }[]} */
  let pipes = [];

  function syncCanvasSize() {
    const ratio = window.devicePixelRatio || 1;
    canvasLite =
      typeof window.matchMedia === "function" &&
      (window.matchMedia("(pointer: coarse)").matches ||
        window.matchMedia("(max-width: 768px)").matches);
    /** Phones: DPR 1 keeps the backbuffer small (biggest win vs “airy” jank). */
    dpr = Math.min(ratio, canvasLite ? 1 : 2);
    canvas.style.width = WIDTH + "px";
    canvas.style.height = HEIGHT + "px";
    canvas.width = Math.round(WIDTH * dpr);
    canvas.height = Math.round(HEIGHT * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    if ("imageSmoothingQuality" in ctx) {
      ctx.imageSmoothingQuality = canvasLite ? "low" : "high";
    }
  }

  function hideStart() {
    overlayStart.classList.remove("visible");
  }

  function showStart() {
    overlayStart.classList.add("visible");
  }

  function hideGameOver() {
    overlayGameover.classList.remove("visible");
  }

  function showGameOver() {
    overlayGameover.classList.add("visible");
    if (finalCoinsEl) {
      finalCoinsEl.textContent = String(coins);
    }
  }

  function updateScoreHud() {
    if (scoreEl) {
      scoreEl.textContent = String(score);
    }
  }

  function reset() {
    state = "ready";
    score = 0;
    coins = 0;
    pipes = [];
    bgScroll = 0;
    bird.x = BIRD_X;
    bird.y = HEIGHT / 2;
    bird.vy = 0;
    updateScoreHud();
    showStart();
    hideGameOver();
  }

  function spawnPipe() {
    const gapH =
      GAP_H_MIN + Math.random() * (GAP_H_MAX - GAP_H_MIN);
    const maxTop = HEIGHT - gapH - PIPE_MIN_MARGIN;
    const minTop = PIPE_MIN_MARGIN;
    const gapY = minTop + Math.random() * Math.max(0, maxTop - minTop);
    const spacingAfter =
      PIPE_SPACING_MIN +
      Math.random() * (PIPE_SPACING_MAX - PIPE_SPACING_MIN);
    const hasCoin = gapH >= COIN_MIN_GAP;
    pipes.push({
      x: WIDTH + PIPE_W + 10,
      gapY: gapY,
      gapH: gapH,
      spacingAfter: spacingAfter,
      scored: false,
      hasCoin: hasCoin,
      coinCollected: false,
      coinPhase: Math.random() * Math.PI * 2,
    });
  }

  function birdHitbox() {
    return {
      left: bird.x - BIRD_W / 2 + HIT_INSET,
      right: bird.x + BIRD_W / 2 - HIT_INSET,
      top: bird.y - BIRD_H / 2 + HIT_INSET,
      bottom: bird.y + BIRD_H / 2 - HIT_INSET,
    };
  }

  function rectsOverlap(a, b) {
    return (
      a.left < b.right &&
      a.right > b.left &&
      a.top < b.bottom &&
      a.bottom > b.top
    );
  }

  function circleRectOverlap(cx, cy, r, rect) {
    const nx = Math.max(rect.left, Math.min(cx, rect.right));
    const ny = Math.max(rect.top, Math.min(cy, rect.bottom));
    const dx = cx - nx;
    const dy = cy - ny;
    return dx * dx + dy * dy < r * r;
  }

  /**
   * Smooth vertical bob (time-based only). Phase must NOT use p.x — scrolling x was
   * canceling the time term so coins looked frozen on-screen.
   */
  function coinBobOffset(p) {
    const t = performance.now() * 0.001;
    const phase = p.coinPhase || 0;
    return Math.sin(t * COIN_BOB_SPEED + phase) * COIN_BOB_AMPLITUDE;
  }

  function pipeRects(p) {
    const xl = p.x + PIPE_SIDE_INSET;
    const xr = p.x + PIPE_W - PIPE_SIDE_INSET;
    const top = {
      left: xl,
      right: xr,
      top: PIPE_SIDE_INSET,
      bottom: p.gapY - PIPE_GAP_SOFT,
    };
    const bottom = {
      left: xl,
      right: xr,
      top: p.gapY + p.gapH + PIPE_GAP_SOFT,
      bottom: HEIGHT - PIPE_SIDE_INSET,
    };
    return [top, bottom];
  }

  function die() {
    if (coins > bestCoins) {
      bestCoins = coins;
      saveBestCoins(bestCoins);
    }
    state = "gameover";
    showGameOver();
  }

  function flap() {
    if (state === "gameover") {
      reset();
      return;
    }
    if (state === "ready") {
      state = "playing";
      hideStart();
      spawnPipe();
    }
    bird.vy = FLAP;
  }

  function updatePlaying() {
    bird.vy = Math.min(bird.vy + GRAVITY, MAX_VY);
    bird.y += bird.vy;

    const hb = birdHitbox();
    const ceiling = 0;
    const floorY = HEIGHT;

    if (hb.top < ceiling || hb.bottom > floorY) {
      die();
      return;
    }

    const last = pipes[pipes.length - 1];
    const nextGap =
      last && last.spacingAfter != null
        ? last.spacingAfter
        : (PIPE_SPACING_MIN + PIPE_SPACING_MAX) / 2;
    if (!last || last.x < WIDTH - nextGap) {
      spawnPipe();
    }

    bgScroll += PIPE_SPEED;

    for (let i = pipes.length - 1; i >= 0; i--) {
      const p = pipes[i];
      p.x -= PIPE_SPEED;

      if (!p.scored && p.x + PIPE_W < bird.x - BIRD_W / 2) {
        p.scored = true;
        score += 1;
        updateScoreHud();
      }

      const prs = pipeRects(p);
      for (let j = 0; j < prs.length; j++) {
        if (rectsOverlap(hb, prs[j])) {
          die();
          return;
        }
      }

      if (
        p.hasCoin &&
        !p.coinCollected &&
        circleRectOverlap(
          p.x + PIPE_W / 2,
          p.gapY + p.gapH / 2 + coinBobOffset(p),
          COIN_R,
          hb
        )
      ) {
        p.coinCollected = true;
        coins += 1;
        if (coins > bestCoins) {
          bestCoins = coins;
          saveBestCoins(bestCoins);
        }
      }

      if (p.x + PIPE_W < 0) {
        pipes.splice(i, 1);
      }
    }
  }

  function bgTileWidth() {
    if (!bgReady || !bgImg.naturalHeight) {
      return WIDTH;
    }
    return (bgImg.naturalWidth / bgImg.naturalHeight) * HEIGHT;
  }

  /** Smoothstep for seam blend weight (0–1). */
  function smoothstep01(t) {
    const x = Math.max(0, Math.min(1, t));
    return x * x * (3 - 2 * x);
  }

  /** Crossfade strip between tile repeats (built once after bg loads). */
  let bgSeamStripCanvas = null;
  let bgSeamBlendCached = -1;

  /**
   * Linear blend of the right end of the texture with the left end so the wrap is softer.
   * Cached because it only depends on the background asset and canvas height.
   */
  function ensureBgSeamStrip(blendW, iw, ih, tileW) {
    if (blendW < 2 || bgSeamBlendCached === blendW && bgSeamStripCanvas) {
      return;
    }
    const srcBlend = (blendW / tileW) * iw;
    const h = HEIGHT;
    if (!bgSeamStripCanvas) {
      bgSeamStripCanvas = document.createElement("canvas");
    }
    bgSeamStripCanvas.width = blendW;
    bgSeamStripCanvas.height = h;
    const sctx = bgSeamStripCanvas.getContext("2d", { willReadFrequently: true });

    sctx.drawImage(
      bgImg,
      iw - srcBlend,
      0,
      srcBlend,
      ih,
      0,
      0,
      blendW,
      h
    );
    const idA = sctx.getImageData(0, 0, blendW, h);
    sctx.clearRect(0, 0, blendW, h);
    sctx.drawImage(bgImg, 0, 0, srcBlend, ih, 0, 0, blendW, h);
    const idB = sctx.getImageData(0, 0, blendW, h);
    const out = sctx.createImageData(blendW, h);
    const b1 = Math.max(1, blendW - 1);
    for (let px = 0; px < blendW; px++) {
      const t = smoothstep01(px / b1);
      const om = 1 - t;
      for (let py = 0; py < h; py++) {
        const i = (py * blendW + px) * 4;
        out.data[i] = idA.data[i] * om + idB.data[i] * t;
        out.data[i + 1] = idA.data[i + 1] * om + idB.data[i + 1] * t;
        out.data[i + 2] = idA.data[i + 2] * om + idB.data[i + 2] * t;
        out.data[i + 3] = idA.data[i + 3] * om + idB.data[i + 3] * t;
      }
    }
    sctx.putImageData(out, 0, 0);
    bgSeamBlendCached = blendW;
  }

  function drawBlendedSeam(screenX, blendW, iw, ih, tileW) {
    if (blendW < 2) {
      return;
    }
    ensureBgSeamStrip(blendW, iw, ih, tileW);
    ctx.drawImage(bgSeamStripCanvas, Math.round(screenX), 0);
  }

  /** One drawImage per tile + no seam strip (much cheaper than split body + blend on GPU). */
  function drawBackgroundSimple() {
    const iw = bgImg.naturalWidth;
    const ih = bgImg.naturalHeight;
    const tileW = bgTileWidth();
    let offset = bgScroll % tileW;
    if (offset < 0) {
      offset += tileW;
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, WIDTH, HEIGHT);
    ctx.clip();
    let x = -offset;
    while (x < WIDTH + tileW) {
      ctx.drawImage(bgImg, 0, 0, iw, ih, x, 0, tileW, HEIGHT);
      x += tileW;
    }
    ctx.restore();
  }

  function drawBackground() {
    if (!bgReady || !bgImg.naturalWidth) {
      ctx.fillStyle = "#1a1a2e";
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      return;
    }
    if (canvasLite) {
      drawBackgroundSimple();
      return;
    }
    const iw = bgImg.naturalWidth;
    const ih = bgImg.naturalHeight;
    const tileW = bgTileWidth();
    let offset = bgScroll % tileW;
    if (offset < 0) {
      offset += tileW;
    }
    const blendW = Math.max(
      12,
      Math.min(72, Math.floor(tileW * 0.14))
    );
    const srcBodyW = iw - (blendW / tileW) * iw;
    const bodyW = tileW - blendW;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, WIDTH, HEIGHT);
    ctx.clip();

    let x = -offset;
    while (x < WIDTH + tileW) {
      if (bodyW > 0.5 && srcBodyW > 0.5) {
        ctx.drawImage(
          bgImg,
          0,
          0,
          srcBodyW,
          ih,
          x,
          0,
          bodyW,
          HEIGHT
        );
      }
      const seamX = x + bodyW;
      if (blendW >= 2 && seamX < WIDTH + blendW && seamX + blendW > 0) {
        drawBlendedSeam(seamX, blendW, iw, ih, tileW);
      }
      x += tileW;
    }
    ctx.restore();
  }

  function drawBird() {
    ctx.save();
    const useDead =
      state === "gameover" && deadReady && deadImg.naturalWidth > 0;
    const deadBobY = useDead
      ? Math.sin(performance.now() * DEAD_BOB_SCALE) * DEAD_BOB_AMPLITUDE
      : 0;
    ctx.translate(bird.x, bird.y + deadBobY);
    const tilt = Math.max(-0.6, Math.min(0.9, bird.vy * 0.06));
    ctx.rotate(tilt);
    const sprite = useDead ? deadImg : birdImg;
    const spriteOk =
      sprite.naturalWidth > 0 && (useDead ? deadReady : birdReady);

    if (!spriteOk) {
      ctx.restore();
      return;
    }
    const iw = sprite.naturalWidth;
    const ih = sprite.naturalHeight;
    ctx.drawImage(
      sprite,
      0,
      0,
      iw,
      ih,
      -BIRD_W / 2,
      -BIRD_H / 2,
      BIRD_W,
      BIRD_H
    );
    ctx.restore();
  }

  /**
   * Stretch pipe.png to fill a vertical segment. Bottom segment is flipped so the
   * pipe opening faces the gap (works when the lip is at the bottom of the texture).
   */
  function drawPipeSegment(screenX, screenY, screenW, screenH, flipY) {
    if (!pipeReady || !pipeImg.naturalWidth || screenH <= 0) {
      ctx.fillStyle = "#3d8c40";
      ctx.fillRect(screenX, screenY, screenW, screenH);
      return;
    }
    const iw = pipeImg.naturalWidth;
    const ih = pipeImg.naturalHeight;
    const sx = Math.round(screenX);
    const sy = Math.round(screenY);
    const sw = Math.round(screenW);
    const sh = Math.round(screenH);
    ctx.save();
    if (flipY) {
      ctx.translate(sx, sy + sh);
      ctx.scale(1, -1);
      ctx.drawImage(pipeImg, 0, 0, iw, ih, 0, 0, sw, sh);
    } else {
      ctx.drawImage(pipeImg, 0, 0, iw, ih, sx, sy, sw, sh);
    }
    ctx.restore();
  }

  function drawPipes() {
    for (let i = 0; i < pipes.length; i++) {
      const p = pipes[i];
      const px = Math.round(p.x);
      const topH = p.gapY;
      const bottomY = p.gapY + p.gapH;
      const bottomH = HEIGHT - bottomY;
      drawPipeSegment(px, 0, PIPE_W, topH, true);
      drawPipeSegment(px, bottomY, PIPE_W, bottomH, false);
    }
  }

  function drawCoin(cx, cy) {
    const s = COIN_DRAW_SIZE;
    const half = s / 2;
    ctx.save();
    if (coinReady && coinImg.naturalWidth) {
      const iw = coinImg.naturalWidth;
      const ih = coinImg.naturalHeight;
      ctx.drawImage(coinImg, 0, 0, iw, ih, cx - half, cy - half, s, s);
    } else {
      const r = COIN_R;
      const g = ctx.createRadialGradient(
        cx - r * 0.35,
        cy - r * 0.35,
        r * 0.15,
        cx,
        cy,
        r * 1.1
      );
      g.addColorStop(0, "#fff9c4");
      g.addColorStop(0.45, "#ffc107");
      g.addColorStop(0.85, "#ff8f00");
      g.addColorStop(1, "#e65100");
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();
    }
    ctx.restore();
  }

  /** Coin counter drawn on canvas last so it stays visible above pipes, coins, and bird. */
  const HUD_COIN_ICON = 28;
  const HUD_TOP = 18;
  /** 8-bit style score — matches loaded Press Start 2P from index.html. */
  const HUD_PIXEL_FONT = '16px "Press Start 2P", monospace';
  const HUD_BEST_FONT = '11px "Press Start 2P", monospace';

  function drawHudCoins() {
    ctx.save();
    ctx.font = HUD_PIXEL_FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const text = String(coins);
    const tw = ctx.measureText(text).width;
    const gap = 8;
    const totalW =
      (coinReady && coinImg.naturalWidth ? HUD_COIN_ICON + gap : 0) + tw;
    let drawX = WIDTH / 2 - totalW / 2;
    const cy = HUD_TOP + HUD_COIN_ICON / 2;

    if (coinReady && coinImg.naturalWidth) {
      const iw = coinImg.naturalWidth;
      const ih = coinImg.naturalHeight;
      ctx.drawImage(coinImg, 0, 0, iw, ih, drawX, HUD_TOP, HUD_COIN_ICON, HUD_COIN_ICON);
      drawX += HUD_COIN_ICON + gap;
    }

    const hudBlur = canvasLite ? 0 : 6;
    ctx.fillStyle = "#fff";
    if (hudBlur > 0) {
      ctx.shadowColor = "rgba(0,0,0,0.72)";
      ctx.shadowBlur = hudBlur;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 2;
    }
    ctx.fillText(text, drawX, cy);
    ctx.restore();
  }

  function drawHudBest() {
    ctx.save();
    ctx.font = HUD_BEST_FONT;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const cy = HUD_TOP + HUD_COIN_ICON / 2;
    const label = "HI " + String(bestCoins);
    const hudBlur = canvasLite ? 0 : 5;
    ctx.fillStyle = "#fff";
    if (hudBlur > 0) {
      ctx.shadowColor = "rgba(0,0,0,0.72)";
      ctx.shadowBlur = hudBlur;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 2;
    }
    ctx.fillText(label, WIDTH - 12, cy);
    ctx.restore();
  }

  function drawCoins() {
    for (let i = 0; i < pipes.length; i++) {
      const p = pipes[i];
      if (!p.hasCoin || p.coinCollected) {
        continue;
      }
      const cx = p.x + PIPE_W / 2;
      const cy = p.gapY + p.gapH / 2 + coinBobOffset(p);
      drawCoin(cx, cy);
    }
  }

  function frame() {
    ctx.clearRect(0, 0, WIDTH, HEIGHT);

    if (state === "ready") {
      const t = performance.now() * 0.0031;
      const bobAmp = 14;
      bird.y = HEIGHT / 2 + Math.sin(t) * bobAmp;
      bird.vy = Math.cos(t) * bobAmp * 0.048;
    }

    if (state === "playing") {
      updatePlaying();
    }

    drawBackground();
    drawPipes();
    drawCoins();
    drawBird();
    drawHudCoins();
    drawHudBest();

    requestAnimationFrame(frame);
  }

  function onKeyDown(e) {
    if (e.code === "Space") {
      e.preventDefault();
      flap();
    }
  }

  canvas.addEventListener("pointerdown", function (e) {
    e.preventDefault();
    flap();
  });

  /** WebKit/iOS: pinch & double-tap zoom gestures (viewport alone is not always enough). */
  function preventSafariZoomGestures(ev) {
    ev.preventDefault();
  }
  document.addEventListener("gesturestart", preventSafariZoomGestures, {
    passive: false,
  });
  document.addEventListener("gesturechange", preventSafariZoomGestures, {
    passive: false,
  });
  document.addEventListener("gestureend", preventSafariZoomGestures, {
    passive: false,
  });

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", syncCanvasSize);

  syncCanvasSize();
  if (document.fonts && document.fonts.load) {
    document.fonts.load('16px "Press Start 2P"').catch(function () {});
    document.fonts.load('11px "Press Start 2P"').catch(function () {});
  }
  reset();
  requestAnimationFrame(frame);
})();
