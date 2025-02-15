// eslint-disable-next-line max-classes-per-file
const _ = require('lodash');
const fs = require('fs');
const got = require('got');
// const Canvas = require('canvas');
const Canvas = require('@napi-rs/canvas');
const streamBuffers = require('stream-buffers');
const mime = require('mime-types');
const { GifReader } = require('omggif');
const GifEncoder = require('gifencoder');
const { Readable } = require('stream');

const { createCanvas } = Canvas;
const { Image } = Canvas;

function loadFromUri(uri) {
  if (uri === undefined) {
    return new Promise(resolve => {
      resolve({
        type: 'effect'
      });
    });
  }
  if (uri.startsWith('http')) {
    return got(uri, { encoding: null }).then(res => ({
      type: res.headers['content-type'],
      data: res.body
    }));
  }
  return new Promise((resolve, reject) => {
    fs.readFile(uri, (err, data) => {
      if (err) reject(err);
      resolve({
        type: mime.lookup(uri),
        data
      });
    });
  });
}

function _drawImage(ctx, img, x, y, args = {}) {
  if (args.transform || args.attributes) {
    ctx.save();
    if (args.transform) {
      _.each(args.transform, (val, prop) => {
        // console.log(`Transforming ${prop} by ${val}`);
        ctx[prop](...val);
      });
    }
    if (args.attributes) {
      _.each(args.attributes, (val, prop) => {
        // console.log(`Setting ${prop} to ${val}`);
        ctx[prop] = val;
      });
    }
  }
  if (args.sx !== undefined || args.sy !== undefined || args.swidth !== undefined || args.sheight !== undefined) {
    ctx.drawImage(img, args.sx, args.sy, args.swidth, args.sheight, x, y, args.width || args.swidth, args.height || args.sheight);
  } else {
    ctx.drawImage(img, x, y, args.width, args.height);
  }
  if (args.transform || args.attributes) {
    ctx.restore();
  }
}

class ImageEx {
  constructor(uri) {
    this.uri = uri;
    this.frames = null;
    this.loaded = loadFromUri(uri).then(result => {
      this.type = result.type;
      this.data = result.data;
      if (this.type === 'effect') {
        this.isEffectOnly = true;
      } else if (this.type === 'image/gif') {
        this.initGif();
      } else {
        this.initStatic();
      }
      return this;
    });
  }

  initGif() {
    const reader = new GifReader(new Uint8Array(this.data));
    this.width = reader.width;
    this.height = reader.height;
    this.loops = reader.loopCount();
    // console.log('Decoding frames');
    this.frames = this.decodeFrames(reader);

    // console.log('Frames decoded!');
    this.renderAllFrames();

    return this;
  }

  initStatic() {
    const img = new Image();
    img.onload = () => {
      this.width = img.width;
      this.height = img.height;
      const canvas = createCanvas(this.width, this.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      this.frames = [{
        actualOffset: 0,
        actualDelay: Infinity,
        delay: Infinity,
        canvas
      }];
    };
    img.src = this.data;
  }

  decodeFrames(reader) {
    const frames = [];
    let offset = 0;
    for (let i = 0; i < reader.numFrames(); ++i) {
      const frameInfo = reader.frameInfo(i);
      frameInfo.pixels = new Uint8ClampedArray(reader.width * reader.height * 4);
      reader.decodeAndBlitFrameRGBA(i, frameInfo.pixels);
      frameInfo.buffer = this.createBufferCanvas(frameInfo, this.width, this.height);
      frameInfo.actualOffset = offset;
      frameInfo.actualDelay = Math.max(frameInfo.delay * 10, 20);
      offset += frameInfo.actualDelay;
      frames.push(frameInfo);
    }
    this.totalDuration = offset;
    return frames;
  }

  renderAllFrames() {
    let disposeFrame = null;
    const canvas = createCanvas(this.width, this.height);
    const ctx = canvas.getContext('2d');
    let saved;
    for (let i = 0; i < this.frames.length; ++i) {
      const frame = this.frames[i];
      // console.log('Rendering frame', frame);
      if (typeof disposeFrame === 'function') disposeFrame();

      switch (frame.disposal) {
        case 2:
          disposeFrame = () => ctx.clearRect(0, 0, canvas.width, canvas.height);
          break;
        case 3:
          saved = ctx.getImageData(0, 0, canvas.width, canvas.height);
          disposeFrame = () => ctx.putImageData(saved, 0, 0); // eslint-disable-line no-loop-func
          break;
        default:
          this.disposeFrame = null;
      }

      // draw current frame
      ctx.drawImage(frame.buffer, frame.x, frame.y);

      const frameCanvas = createCanvas(this.width, this.height);
      const frameCtx = frameCanvas.getContext('2d');
      frameCtx.drawImage(canvas, 0, 0);
      frame.canvas = frameCanvas;
    }
  }

  createBufferCanvas(frame, width, height) {
    const canvas = createCanvas(frame.width, frame.height);
    const ctx = canvas.getContext('2d');

    const imageData = ctx.createImageData(width, height);
    imageData.data.set(frame.pixels);

    ctx.putImageData(imageData, -frame.x, -frame.y);
    return canvas;
  }

  drawFrame(ctx, frameNum, x, y, args = {}) {
    _drawImage(ctx, this.frames[frameNum].canvas, x, y, args);
  }
}

class CanvasEx {
  constructor(width, height, loops = 0) {
    this.width = Math.round(width);
    this.height = Math.round(height);
    this.frames = [];
    this.totalDuration = Infinity;
    this.loops = loops;
  }

  setDelay(frame, actualDelay, delay) {
    if (!Number.isFinite(this.totalDuration)) {
      this.totalDuration = 0;
    } else if (Number.isFinite(frame.actualDelay)) this.totalDuration -= frame.actualDelay || 0;
    if ((actualDelay === undefined || actualDelay === null)
      && (delay === undefined || delay === null)) {
      throw new Error('Delay has to be set!');
    }
    if (!Number.isNaN(delay) && delay <= 1) {
      delay = 10;
    }
    frame.delay = delay || Math.max(Math.round(actualDelay / 10), 2);
    frame.actualDelay = actualDelay || Math.max(delay * 10, 20);
    this.totalDuration += frame.actualDelay;
  }

  setLoops(count = 0) {
    this.loops = count;
  }

  addFrame(actualDelay, delay) {
    const canvas = createCanvas(this.width, this.height);
    const frame = {
      actualOffset: this.totalDuration,
      canvas,
      ctx: canvas.getContext('2d')
    };
    this.setDelay(frame, actualDelay, delay);
    this.totalDuration += frame.actualDelay;
    this.frames.push(frame);
  }

  drawImage(img, x, y, args = {}) {
    if (img.frames && img.frames.length > 1) {
      if (this.frames.length > 1) throw new Error('Cannot render animations onto animated canvases!');
      this.totalDuration = 0;
      // we are drawing an animated image onto a static one.
      // for each frame in the image, create a frame on this one, cloning the original picture (if any),
      // render the original on each frame, and draw the frame on top.
      // if this canvas already has a frame, update the duration
      if (this.frames.length > 0) this.setDelay(this.frames[0], null, img.frames[0].delay);
      for (let i = this.frames.length; i < img.frames.length; ++i) {
        const frame = img.frames[i];
        this.addFrame(null, frame.delay);
        if (this.frames.length > 0) {
          this.frames[i].ctx.antialias = 'none';
          _drawImage(this.frames[i].ctx, this.frames[0].canvas, 0, 0, {
            width: this.width,
            height: this.height
          });
          this.frames[i].ctx.antialias = 'default';
        }
      }
      for (let i = 0; i < img.frames.length; ++i) {
        // draw the i-th source frame to the i-th target frame
        img.drawFrame(this.frames[i].ctx, i, x, y, args);
      }
    } else {
      // we are drawing a static image on top of a (possibly animated) image.
      // for each frame, just draw, nothing fancy.
      if (img.frames) { // eslint-disable-line no-lonely-if
        // the image cant have more than one frame, and if it has 0, we dont need to do anything at all
        if (img.frames.length === 1) {
          // if theres no frames at all, add one
          if (this.frames.length === 0) {
            this.addFrame(Infinity);
          }
          for (let i = 0; i < this.frames.length; ++i) {
            img.drawFrame(this.frames[i].ctx, 0, x, y, args);
          }
        }
      } else {
        for (let i = 0; i < this.frames.length; ++i) {
          _drawImage(this.frames[i].ctx, img, x, y, args);
        }
      }
    }
  }

  drawFrame(ctx, frameNum, x, y, args = {}) {
    _drawImage(ctx, this.frames[frameNum].canvas, x, y, args);
  }

  export(outStream) {
    if (this.frames.length > 1) {
      if (outStream.setHeader) outStream.setHeader('Content-Type', 'image/gif');
      const gif = new GifEncoder(this.width, this.height);
      gif.createReadStream().pipe(outStream);
      gif.setRepeat(this.loops);
      // gif.setTransparent(0xfefe01);
      // gif.setRepeat(0);
      gif.setTransparent(this.frames[0].transparent_index);
      gif.start();
      for (let i = 0; i < this.frames.length; ++i) {
        const frame = this.frames[i];
        gif.setDelay(frame.actualDelay);
        gif.addFrame(frame.ctx);
      }
      gif.finish();
    } else if (this.frames.length === 1) {
      if (outStream.setHeader) outStream.setHeader('Content-Type', 'image/png');
      // const stream = this.frames[0].canvas.pngStream();
      const stream = Readable.from(this.frames[0].canvas.toBuffer('image/png'));
      stream.pipe(outStream);
    } else {
      throw new Error('No image data to be exported');
    }
  }

  toBuffer() {
    /* return new Promise(resolve => {
      resolve(this.frames[0].canvas.toBuffer('image/png'));
    }); */

    const buf = new streamBuffers.WritableStreamBuffer({
      initialSize: this.height * this.width * 4 * this.frames.length,
      incrementAmount: this.height * this.width * 4
    });
    this.export(buf);
    return new Promise(resolve => {
      buf.on('finish', () => {
        // console.log('Render completed');
        resolve(buf.getContents());
      });
    });
  }
}

module.exports = {
  CanvasEx,
  ImageEx,
  _drawImage
};
