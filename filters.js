const _ = require('lodash');
// const Canvas = require('canvas');
const Canvas = require('@napi-rs/canvas');
const {
  _drawImage,
  CanvasEx
} = require('./imageex');

const { createCanvas } = Canvas;

const filters = {
  overlay: (canvas, source, x, y, props) => {
    _.each(canvas.frames, frame => {
      const basicProps = {
        width: props.width,
        height: props.height
      };

      const tmpCanvas = createCanvas(frame.canvas.width, frame.canvas.height);
      const tmpCtx = tmpCanvas.getContext('2d');
      _drawImage(tmpCtx, frame.canvas, x, y, basicProps);
      const multiplyProps = _.extend({}, props, { attributes: { globalCompositeOperation: 'multiply' } });
      console.log('multiply props:', multiplyProps);
      _drawImage(tmpCtx, source.frames[0].canvas, x, y, multiplyProps);

      const tmpCanvas2 = createCanvas(frame.canvas.width, frame.canvas.height);
      const tmpCtx2 = tmpCanvas2.getContext('2d');
      _drawImage(tmpCtx2, frame.canvas, x, y, basicProps);
      const sourceInProps = _.extend({}, props, { attributes: { globalCompositeOperation: 'source-in' } });
      _drawImage(tmpCtx2, source.frames[0].canvas, x, y, sourceInProps);

      const combineProps2 = _.extend({}, basicProps, {
        attributes: {
          globalCompositeOperation: 'source-atop',
          globalAlpha: 1
        }
      });
      _drawImage(frame.ctx, tmpCanvas2, x, y, combineProps2);
      const combineProps = _.extend({}, basicProps, {
        attributes: {
          globalCompositeOperation: 'source-atop',
          globalAlpha: 0.6
        }
      });
      _drawImage(frame.ctx, tmpCanvas, x, y, combineProps);
    });
    return canvas;
  },
  mirror_x: (canvas, source, x, y, props) => {
    canvas.drawImage(source, x, y, props);
    let count = 0;
    _.each(canvas.frames, frame => {
      frame.ctx.clearRect(0, 0, frame.canvas.width, frame.canvas.height);
      frame.ctx.translate(0 + props.transform.translate[0], props.height - props.transform.translate[1]);
      frame.ctx.scale(1 * props.transform.scale[0], -1 * props.transform.scale[1]);
      frame.ctx.drawImage(source.frames[count++].canvas, 0, 0);
    });
    return canvas;
  },
  mirror_y: (canvas, source, x, y, props) => {
    canvas.drawImage(source, x, y, props);
    let count = 0;
    _.each(canvas.frames, frame => {
      frame.ctx.clearRect(0, 0, frame.canvas.width, frame.canvas.height);
      frame.ctx.translate(props.width - props.transform.translate[0], 0 + props.transform.translate[1]);
      frame.ctx.scale(-1 * props.transform.scale[0], 1 * props.transform.scale[1]);
      frame.ctx.drawImage(source.frames[count++].canvas, 0, 0);
    });
    return canvas;
  },
  invert_transparency: (canvas, source, x, y, props) => {
    canvas.drawImage(source, x, y, props);
    _.each(canvas.frames, frame => {
      const ctx = frame.canvas.getContext('2d');
      const id = ctx.getImageData(0, 0, canvas.frames[0].canvas.width, canvas.frames[0].canvas.height);
      ctx.clearRect(0, 0, canvas.frames[0].canvas.width, canvas.frames[0].canvas.height);
      const { data } = id;
      for (let i = 3; i < data.length; i += 4) {
        data[i] = 255 - data[i];
      }
      ctx.putImageData(id, 0, 0);
    });
    return canvas;
  },
  pokemon_static: (canvas, source, x, y, props) => {
    canvas.drawImage(source, x, y, props);
    _.each(canvas.frames, frame => {
      const ctx = frame.canvas.getContext('2d');
      const id = ctx.getImageData(0, 0, canvas.frames[0].canvas.width, canvas.frames[0].canvas.height);
      ctx.clearRect(0, 0, canvas.frames[0].canvas.width, canvas.frames[0].canvas.height);
      const { data } = id;
      for (let i = 0; i < data.length; i += 4) {
        const r = 0x00001d;
        const g = 0x000065;
        const b = 0x000099;

        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
      }
      ctx.putImageData(id, 0, 0);
    });
    return canvas;
  },
  pokemon_reveal: (canvas, source, x, y, props) => {
    canvas.drawImage(source, x, y, props);
    _.each(canvas.frames, frame => {
      const ctx = frame.canvas.getContext('2d');
      const id = ctx.getImageData(0, 0, canvas.frames[0].canvas.width, canvas.frames[0].canvas.height);
      // ctx.clearRect(0, 0, canvas.frames[0].canvas.width, canvas.frames[0].canvas.height);
      const { data } = id;
      for (let i = 0; i < data.length; i += 4) {
        const r = 0x00001d;
        const g = 0x000065;
        const b = 0x000099;

        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
      }
      ctx.putImageData(id, 0, 0);
    });

    const fadeLengthFrames = 10;

    let fadeCount = 0;
    for (let run = 0; run < 5; run++) {
      if (source.frames.length === 1) {
        for (let i1 = 0; i1 < fadeLengthFrames; i1++) {
          const tmpCanvas = new CanvasEx(canvas.frames[0].canvas.width, canvas.frames[0].canvas.height);
          tmpCanvas.drawImage(source, x, y, props);
          canvas.addFrame(0, 10);
          const frame = tmpCanvas.frames[0];
          const finalFrame = canvas.frames[canvas.frames.length - 1];
          const ctx = frame.canvas.getContext('2d');
          const id = ctx.getImageData(0, 0, canvas.frames[0].canvas.width, canvas.frames[0].canvas.height);
          // ctx.clearRect(0, 0, canvas.frames[0].canvas.width, canvas.frames[0].canvas.height);
          const { data } = id;
          for (let i = 0; i < data.length; i += 4) {
            let fadePercentage = i1 / fadeLengthFrames;
            if (run < 2) fadePercentage = 0;
            else if (run > 2) fadePercentage = 1;
            const startR = 0x00001d;
            const startG = 0x000065;
            const startB = 0x000099;
            const endR = data[i];
            const endG = data[i + 1];
            const endB = data[i + 2];
            const r = startR + (endR - startR) * fadePercentage;
            const g = startG + (endG - startG) * fadePercentage;
            const b = startB + (endB - startB) * fadePercentage;
            data[i] = r;
            data[i + 1] = g;
            data[i + 2] = b;
          }
          if (run === 2) fadeCount++;
          finalFrame.canvas.getContext('2d').putImageData(id, 0, 0);
        }
      } else {
        const replays = Math.ceil(fadeLengthFrames / source.frames.length);
        for (let i2 = 0; i2 < replays; i2++) {
          const tmpCanvas = new CanvasEx(canvas.frames[0].canvas.width, canvas.frames[0].canvas.height);
          tmpCanvas.drawImage(source, x, y, props);
          // eslint-disable-next-line no-loop-func
          _.each(tmpCanvas.frames, frame => {
            canvas.addFrame(0, frame.delay);
            const finalFrame = canvas.frames[canvas.frames.length - 1];
            const ctx = frame.canvas.getContext('2d');
            const id = ctx.getImageData(0, 0, canvas.frames[0].canvas.width, canvas.frames[0].canvas.height);
            // ctx.clearRect(0, 0, canvas.frames[0].canvas.width, canvas.frames[0].canvas.height);
            const { data } = id;
            for (let i = 0; i < data.length; i += 4) {
              let fadePercentage = fadeCount / (source.frames.length * replays);
              if (run < 2) fadePercentage = 0;
              else if (run > 2) fadePercentage = 1;

              // console.log(`fadePercentage: ${fadePercentage}, run: ${run}`);

              const startR = 0x00001d;
              const startG = 0x000065;
              const startB = 0x000099;
              const endR = data[i];
              const endG = data[i + 1];
              const endB = data[i + 2];
              const r = startR + ((endR - startR) * fadePercentage);
              const g = startG + ((endG - startG) * fadePercentage);
              const b = startB + ((endB - startB) * fadePercentage);
              data[i] = r;
              data[i + 1] = g;
              data[i + 2] = b;
            }
            if (run === 2) fadeCount++;
            finalFrame.canvas.getContext('2d').putImageData(id, 0, 0);
          });
        }
      }
    }
    return canvas;
  }
};
module.exports = filters;
