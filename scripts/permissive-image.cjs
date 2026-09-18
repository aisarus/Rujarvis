const { createCanvas, loadImage } = require('@napi-rs/canvas');

function drawImage(ctx, image, width, height, fit) {
  if (fit === 'fill') {
    ctx.drawImage(image, 0, 0, width, height);
    return;
  }

  const scale = Math.min(width / image.width, height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  const left = (width - drawWidth) / 2;
  const top = (height - drawHeight) / 2;
  ctx.drawImage(image, left, top, drawWidth, drawHeight);
}

async function render(input, options = {}) {
  const image = await loadImage(input);
  const width = Math.max(1, Math.round(options.width ?? image.width));
  const height = Math.max(
    1,
    Math.round(options.height ?? (options.width ? image.height * (width / image.width) : image.height)),
  );
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  if (options.background) {
    ctx.fillStyle = options.background;
    ctx.fillRect(0, 0, width, height);
  }
  drawImage(ctx, image, width, height, options.fit ?? 'fill');

  return { canvas, ctx, width, height };
}

async function metadata(input) {
  const image = await loadImage(input);
  return { width: image.width, height: image.height };
}

async function png(input, options = {}) {
  const rendered = await render(input, options);
  return await rendered.canvas.encode('png');
}

async function compositeSvg(input, svg, options = {}) {
  const rendered = await render(input, options);
  const overlay = await loadImage(Buffer.isBuffer(svg) ? svg : Buffer.from(svg));
  rendered.ctx.drawImage(overlay, 0, 0, rendered.width, rendered.height);
  return await rendered.canvas.encode('png');
}

async function rawRgba(input, options = {}) {
  const rendered = await render(input, options);
  return {
    data: rendered.ctx.getImageData(0, 0, rendered.width, rendered.height).data,
    width: rendered.width,
    height: rendered.height,
  };
}

async function pngFromRgba(data, width, height) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(width, height);
  imageData.data.set(data);
  ctx.putImageData(imageData, 0, 0);
  return await canvas.encode('png');
}

async function transformRgba(input, options, transform) {
  const rendered = await render(input, options);
  const imageData = rendered.ctx.getImageData(0, 0, rendered.width, rendered.height);
  transform(imageData.data);
  rendered.ctx.putImageData(imageData, 0, 0);
  return await rendered.canvas.encode('png');
}

module.exports = {
  compositeSvg,
  createCanvas,
  loadImage,
  metadata,
  png,
  pngFromRgba,
  rawRgba,
  render,
  transformRgba,
};
