process.on('uncaughtException', err => {
  console.log(err);
});

const { parentPort } = require('worker_threads');

// console.log(`Worker start ${workerData.emoji.name}`);
// const config = require('./config.default.json');
const _ = require('lodash');
const fs = require('fs');
const config = require('./config.json');
const filters = require('./filters');
const {
  ImageEx,
  CanvasEx
} = require('./imageex');

const { templates } = config;

function all(x, c) {
  _.isArray(x) ? _.each(x, c) : c(x);
}

// drawing: we keep the image fixed in its default position and draw the template on top/below it

// global variable, can be used to get the previous template calculations
let previousCalculation; // eslint-disable-line no-unused-vars
function getNumericAnchor(anchor, imgWidth, imgHeight) { // eslint-disable-line no-unused-vars
  // eslint-disable-next-line max-len
  return _.mapValues(anchor, dimension => _.mapValues(dimension, value => (Number.isFinite(value) ? Number(value) : eval(value)))); // eslint-disable-line no-eval
}

// calculates the x or y position of the template to be drawn
// size = width or height of the template/image
// anchor = the corresponding anchor config
function calculatePosition(scale, anchor, imageSize) {
  if (anchor.absolute) {
    return anchor.offset;
  }
  return imageSize * anchor.position / 100 - anchor.offset * scale;
}

function render(template, img, size, flipH) {
  let imgWidth = img.width;
  let imgHeight = img.height;
  if (size && size.height) {
    imgHeight = size.height;
    if (!size.width) imgWidth = imgWidth * size.height / img.height;
  }
  if (size && size.width) {
    imgWidth = size.width;
    if (!size.height) imgHeight = imgHeight * size.width / img.width;
  }

  const anchor = getNumericAnchor(template.anchor, imgWidth, imgHeight);
  const xScale = template.image.isEffectOnly ? 1 : (imgWidth / anchor.x.size);
  const yScale = template.image.isEffectOnly ? 1 : (imgHeight / anchor.y.size);
  const templateScale = Math.max(0, Math.min(10, Math.max(xScale || 0, yScale || 0)));

  let templateOffsetX;
  let templateOffsetY;
  templateOffsetX = calculatePosition(templateScale, anchor.x || 0, imgWidth);
  templateOffsetY = calculatePosition(templateScale, anchor.y || 0, imgHeight);

  let imageOffsetX = 0;
  let imageOffsetY = 0;
  let resultingWidth = imgWidth; // start with the image boundaries as defined by the image
  let resultingHeight = imgHeight;
  if (templateOffsetX < 0) {
    resultingWidth -= templateOffsetX;
    imageOffsetX = -templateOffsetX;
    templateOffsetX = 0;
  }
  if (templateOffsetY < 0) {
    resultingHeight -= templateOffsetY;
    imageOffsetY = -templateOffsetY;
    templateOffsetY = 0;
  }
  if (templateOffsetX + template.image.width * templateScale > resultingWidth) {
    resultingWidth = templateOffsetX + template.image.width * templateScale;
  }
  if (templateOffsetY + template.image.height * templateScale > resultingHeight) {
    resultingHeight = templateOffsetY + template.image.height * templateScale;
  }

  previousCalculation = {
    templateOffsetX,
    templateOffsetY,
    resultingWidth,
    resultingHeight,
    xScale,
    yScale,
    templateScale
  };
  let toDraw;
  if (!template.image.isEffectOnly) {
    toDraw = [{
      z: 1,
      image: img,
      x: flipH ? resultingWidth - imageOffsetX - imgWidth : imageOffsetX,
      y: imageOffsetY,
      h: imgHeight,
      w: imgWidth,
      attributes: template.srcAttributes,
      filter: filters[template.srcFilter],
      name: 'image'
    }, {
      z: template.z || 0,
      image: template.image,
      x: templateOffsetX,
      y: templateOffsetY,
      h: template.image.height * templateScale,
      w: template.image.width * templateScale,
      name: `template ${template.src}`,
      flipH,
      attributes: template.attributes,
      filter: filters[template.filter]
    }].sort((u, v) => u.z - v.z);
  } else {
    toDraw = [{
      z: 1,
      image: img,
      x: flipH ? resultingWidth - imageOffsetX - imgWidth : imageOffsetX,
      y: imageOffsetY,
      h: imgHeight,
      w: imgWidth,
      flipH,
      attributes: template.srcAttributes,
      filter: filters[template.srcFilter],
      name: 'image'
    }];
  }
  let canvas = new CanvasEx(resultingWidth, resultingHeight, img.loops);

  for (let i = 0; i < toDraw.length; ++i) {
    const subject = toDraw[i];
    try {
      const transform = {};
      if (subject.flipH) {
        transform.translate = [resultingWidth, 0];
        transform.scale = [-1, 1];
      } else {
        transform.translate = [0, 0];
        transform.scale = [1, 1];
      }
      if (subject.filter) {
        canvas = subject.filter(canvas, subject.image, subject.x, subject.y, {
          width: subject.w,
          height: subject.h,
          transform,
          attributes: subject.attributes
        });
      } else {
        canvas.drawImage(subject.image, subject.x, subject.y, {
          width: subject.w,
          height: subject.h,
          transform,
          attributes: subject.attributes
        });
      }
    } catch (err) {
      console.error(err);
      throw new Error(JSON.stringify({
        status: 400,
        error: 'Invalid template'
      }));
    }
  }

  // return the image and cache it
  return (canvas);
}

_.each(templates, (template, templateName) => {
  const data = templates[templateName];
  all(data, templatePart => {
    templatePart.image = new ImageEx(templatePart.src);
  });
});

const MAX_COMMANDS = 500;
const MIBIBYTE = 1024 * 1024;

async function generateImage(data) {
  // eslint-disable-next-line prefer-destructuring
  const emoji = data.emoji;
  const filename = data.messageId;
  const fileExt = emoji.ext;
  console.log(`Generating ${filename}`);
  // eslint-disable-next-line prefer-destructuring
  let input = data.text;
  let tempResult = null;
  let result = null;
  const MAX_FILE_SIZE = data.fileLimitMB;
  let tem;
  let cmd;
  let cmdStripped;
  const cmds = input.split(' ');
  try {
    let repeatedTotal = 0;
    let breakOut = false;
    // eslint-disable-next-line guard-for-in,no-restricted-syntax
    for (tem in templates) {
      if (breakOut) break;
      for (let i = 0; i < cmds.length; i++) {
        if (breakOut) break;
        cmd = cmds[i];
        cmdStripped = cmd.replace('/', '').replace('\\', '');
        if (cmdStripped.startsWith(`${tem}x`)) {
          const repeatNum = Math.min(cmd.split('x')[1], MAX_COMMANDS + 1);
          let repeated = '';
          for (let x = 0; x < repeatNum; x++) {
            repeated += `${cmd.split('x')[0]} `;
          }
          repeatedTotal += repeatNum;
          input = input.replace(cmd, repeated);
          if (repeatedTotal >= MAX_COMMANDS) breakOut = true;
        }
      }
    }
    const messageSplit = input.split(' ');
    let count = 0;
    let content;
    for (let i = 0; i < messageSplit.length; ++i) {
      if (count > MAX_COMMANDS) {
        content = `Only ${MAX_COMMANDS} commands can be applied at once.`;
        break;
      }
      const commandParsed = /^([/\\])(\w+)\b/.exec(messageSplit[i]);
      if (commandParsed) {
        const [, direction, command] = commandParsed;
        if (templates[command]) {
          // console.log('Got command ', direction, command, direction === '\\' ? 'flipped' : 'not flipped', emoji);
          count++;
          // name += command;
          if (tempResult === null) {
            tempResult = new ImageEx(emoji.url);
            await tempResult.loaded; // eslint-disable-line no-await-in-loop
          }
          const templateData = templates[command];
          all(templateData, template => { // eslint-disable-line no-loop-func
            try {
              tempResult = render(template, tempResult, null, direction === '\\');
            } catch (err) {
              // console.error(err);
              content = 'Error rendering image';
              parentPort.postMessage([null, null, content]);
            }
          });
          if (tempResult) {
            console.log('Rendered template number ', count);
            // eslint-disable-next-line no-await-in-loop
            const tempSize = +((await tempResult.toBuffer()).byteLength / MIBIBYTE).toFixed(2);
            console.log(`tempResult size: ${tempSize}MB`);
            if (tempSize > MAX_FILE_SIZE) {
              // eslint-disable-next-line max-len
              content = result ? `Next image is too large to send (size: ${tempSize}MB - limit: ${MAX_FILE_SIZE}MB), stopped at last layer (${count - 1}) before size limit` : `Image is too large to send (size: ${tempSize}MB - limit: ${MAX_FILE_SIZE}MB)`;
              if (!result) {
                parentPort.postMessage([null, null, content]);
                return;
              }
              break;
            } else {
              result = tempResult;
            }
          }
        }
      } else if (i === 0) return;
    }
    if (result) {
      result.toBuffer().then(attachment => {
        const size = +(attachment.byteLength / MIBIBYTE).toFixed(2);
        console.log(`Buffer size: ${size}MB`);
        if (size > MAX_FILE_SIZE) {
          content = `Image is too large to send (size: ${size}MB - limit: ${MAX_FILE_SIZE}MB)`;
          parentPort.postMessage([null, null, content]);
          return;
        }
        const path = `./output/${filename}.${result.frames.length > 1 ? 'gif' : fileExt}`;
        console.log(`Result frame count: ${result.frames.length}`);
        fs.mkdirSync('./output', { recursive: true });
        fs.writeFileSync(path, attachment);
        parentPort.postMessage([path, `${filename}.${result.frames.length > 1 ? 'gif' : fileExt}`, content]);
      });
    }
  } catch (err) {
    console.log(err);
  }
}

parentPort.on('message', data => {
  generateImage(data);
});
