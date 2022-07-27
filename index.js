const fs = require('fs');
const { Worker } = require('worker_threads');
const _ = require('lodash');
const express = require('express');
const Discord = require('discord.js');

const {
  Constants
} = require('discord.js');
const {
  CanvasEx,
  ImageEx
} = require('./imageex');

const twemoji = require('./twemoji');

const app = express();
const config = require('./config.default.json');

const filters = require('./filters');

try {
  _.extend(config, require('./config.json')); // eslint-disable-line global-require
} catch (err) {
  console.log('No config.json found!');
}

function all(x, c) {
  _.isArray(x) ? _.each(x, c) : c(x);
}

const { templates } = config;

_.each(templates, (template, templateName) => {
  const data = templates[templateName];
  all(data, templatePart => {
    templatePart.image = new ImageEx(templatePart.src);
  });
});

// drawing: we keep the image fixed in its default position and draw the template on top/below it

// calculates the x or y position of the template to be drawn
// size = width or height of the template/image
// anchor = the corresponding anchor config
function calculatePosition(scale, anchor, imageSize) {
  if (anchor.absolute) {
    return anchor.offset;
  }
  return imageSize * anchor.position / 100 - anchor.offset * scale;
}

// global variable, can be used to get the previous template calculations
let previousCalculation; // eslint-disable-line no-unused-vars
function getNumericAnchor(anchor, imgWidth, imgHeight) { // eslint-disable-line no-unused-vars
  return _.mapValues(anchor, dimension => _.mapValues(dimension, value => (Number.isFinite(value) ? Number(value) : eval(value)))); // eslint-disable-line no-eval
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

  console.log('Drawing template: ', template);
  const anchor = getNumericAnchor(template.anchor, imgWidth, imgHeight);
  console.log('Numeric anchor: ', anchor);
  const xScale = imgWidth / anchor.x.size;
  const yScale = imgHeight / anchor.y.size;
  const templateScale = Math.max(0, Math.min(10, Math.max(xScale || 0, yScale || 0)));

  let templateOffsetX;
  let templateOffsetY;
  templateOffsetX = calculatePosition(templateScale, anchor.x, imgWidth);
  templateOffsetY = calculatePosition(templateScale, anchor.y, imgHeight);

  console.log('xScale', xScale);
  console.log('yScale', yScale);
  console.log('templateOffsetX', templateOffsetX);
  console.log('templateOffsetY', templateOffsetY);

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
  const toDraw = [{
    z: 1,
    image: img,
    x: flipH ? resultingWidth - imageOffsetX - imgWidth : imageOffsetX,
    y: imageOffsetY,
    h: imgHeight,
    w: imgWidth,
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
  console.log('To draw:', toDraw);

  let canvas = new CanvasEx(resultingWidth, resultingHeight);

  for (let i = 0; i < toDraw.length; ++i) {
    const subject = toDraw[i];
    console.log(`Drawing ${subject.name}${subject.flipH ? ' (flipped)' : ''}`);
    try {
      const transform = {};
      if (subject.flipH) {
        transform.translate = [resultingWidth, 0];
        transform.scale = [-1, 1];
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

app.get('/debug/frame/', async (req, res) => {
  try {
    const img = new ImageEx(req.query.url);
    await img.loaded;
    console.log(img.frames);
    return img.frames[req.query.num].canvas.pngStream().pipe(res);
  } catch (err) {
    console.log(err);
    return res.status(400).end(err.message);
  }
});

app.get('/', async (req, res) => {
  try {
    const templateList = [];
    for (const key in templates) {
      if (templates.hasOwnProperty(key)) { // to be safe
        templateList.push(key);
      }
    }
    console.log(templateList);
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(templateList));
  } catch (err) {
    console.log(err);
    return res.status(400).end(err.message);
  }
});

app.get('/:templateName/', async (req, res) => {
  if (!templates[req.params.templateName]) return res.status(404).end();
  try {
    if (!/^https?:/.test(req.query.url)) {
      return res.status(400).end('Invalid url!');
    }
    const direction = req.query.reverse === 'true' ? '\\' : '/';
    console.log('Got command ', direction, req.params.templateName, direction === '\\' ? 'flipped' : 'not flipped', req.query.url);
    let result = new ImageEx(req.query.url);
    await result.loaded; // eslint-disable-line no-await-in-loop
    const templateData = templates[req.params.templateName];
    all(templateData, template => { // eslint-disable-line no-loop-func
      result = render(template, result, null, direction === '\\');
    });

    return result.export(res);
  } catch (err) {
    console.log(err);
    return res.status(400).end({ error: err.message });
  }
});

app.listen(config.http.port, () => {
  console.log(`Beebot app listening on port ${config.http.port}!`);
});

// Discord stuff

const client = new Discord.Client({
  intents:
    Discord.Intents.FLAGS.GUILDS
    | Discord.Intents.FLAGS.GUILD_MESSAGES
    | Discord.Intents.FLAGS.GUILD_MEMBERS
});
// manage roles permission is required
const invitelink = `https://discordapp.com/oauth2/authorize?client_id=${
  config.discord.client_id}&scope=bot&permissions=0`;
/* const authlink = `https://discordapp.com/oauth2/authorize?client_id=${
  config.discord.client_id}&scope=email`; */
console.log(`Bot invite link: ${invitelink}`);

client.login(config.discord.token).catch(error => {
  if (error) {
    console.error('Couldn\'t login: ', error.toString());
  }
});

const discordAvatarRegex = /(https:\/\/cdn.discordapp.com\/avatars\/\w+\/\w+\.(\w+)\?size=)(\w+)/;

async function findEmoji(message) {
  // find a user mention
  if (message.mentions.users.size > 0) {
    const mentionedUser = message.mentions.users.first();
    const mentionedMember = message.mentions.members.first();
    let avatarUrl = mentionedMember !== undefined ? mentionedMember.displayAvatarURL({
      format: 'png',
      dynamic: true
    }) : mentionedUser.displayAvatarURL({
      format: 'png',
      dynamic: true
    });
    console.log(`Member url: ${mentionedMember.displayAvatarURL({
      format: 'png',
      dynamic: true
    })}`);
    const avatarMatch = discordAvatarRegex.exec(avatarUrl);
    if (avatarMatch) {
      // const ext = avatarMatch[2];
      avatarUrl = `${avatarMatch[1]}128`;
    }
    return {
      name: mentionedMember ? mentionedMember.displayName : mentionedUser.username,
      id: mentionedUser.id,
      url: avatarUrl,
      ext: avatarUrl.indexOf('.gif') >= 0 ? 'gif' : 'png'
    };
  }

  if (message.attachments.size > 0) {
    const attachment = message.attachments.first();
    return {
      name: attachment.name,
      url: attachment.url,
      id: attachment.id,
      ext: attachment.name.indexOf('.gif') >= 0 ? 'gif' : 'png'
    };
  }

  if (message.stickers.size > 0) {
    const sticker = message.stickers.first();
    return {
      name: sticker.name,
      url: sticker.url,
      id: sticker.id,
      ext: 'png'
    };
  }

  const str = message.cleanContent;
  // find a discord emote
  const discordEmote = /<(a?):(\w+):(\d+)>/g.exec(str);
  if (discordEmote) {
    const ext = discordEmote[1] === 'a' ? 'gif' : 'png';
    return {
      name: discordEmote[2],
      id: discordEmote[3],
      url: `https://cdn.discordapp.com/emojis/${discordEmote[3]}.${ext}`,
      ext
    };
  }

  // find a unicode emoji
  let unicodeEmoji;
  twemoji.parse(str, (name, emoji) => {
    if (unicodeEmoji) return false;
    unicodeEmoji = {
      name,
      id: name,
      url: `${emoji.base + emoji.size}/${name}${emoji.ext}`,
      ext: emoji.ext
    };
    return false;
  });
  if (unicodeEmoji) return unicodeEmoji;

  return null;
}

function reverseString(str) {
  return str.split('').reverse().join('');
}

const commands = Object.keys(templates).sort().map(x => `/${x}`).join(', ');
const otherCommands = {
  invite: 'Invite link: Naaah',
  help: `Available commands: ${commands}.\nUse \\\\<command> to flip the template horizontally.\nInvite link: Naaah`,
  beebot: `Available commands: ${commands}.\nUse \\\\<command> to flip the template horizontally.\nInvite link: Naaah`
};

const choices = [];
for (let i = 0; i < templates.length; i++) {
  const templateName = templates[i];
  choices.push({
    name: templateName,
    value: templateName
  });
}
for (let i = 0; i < templates.length; i++) {
  const templateName = templates[i];
  choices.push({
    name: `${templateName} (reversed)`,
    value: `_${templateName}`
  });
}

client.on(Constants.Events.CLIENT_READY, async disc => {
  const templateCommand = {
    name: 'template',
    description: 'Add a template to the given image',
    options: [{
      name: 'link',
      description: 'Add a template to the image at the given link',
      type: 'SUB_COMMAND',
      options: [{
        name: 'link',
        description: 'Link to the image',
        type: 'STRING',
        required: true
      }, {
        name: 'modifier1',
        description: 'The template to apply first',
        type: 'STRING',
        required: true,
        autocomplete: true
      }, {
        name: 'modifier2',
        description: 'The template to apply second',
        type: 'STRING',
        required: false,
        autocomplete: true
      }, {
        name: 'modifier3',
        description: 'The template to apply third',
        type: 'STRING',
        required: false,
        autocomplete: true
      }, {
        name: 'modifier4',
        description: 'The template to apply fourth',
        type: 'STRING',
        required: false,
        autocomplete: true
      }, {
        name: 'modifier5',
        description: 'The template to apply fifth',
        type: 'STRING',
        required: false,
        autocomplete: true
      }]
    }, {
      name: 'emote',
      description: 'Add a template to an emote',
      type: 'SUB_COMMAND',
      options: [{
        name: 'emote',
        description: 'The emote to add the template to',
        type: 'STRING',
        required: true
      }, {
        name: 'modifier1',
        description: 'The template to apply first',
        type: 'STRING',
        required: true,
        autocomplete: true
      }, {
        name: 'modifier2',
        description: 'The template to apply second',
        type: 'STRING',
        required: false,
        autocomplete: true
      }, {
        name: 'modifier3',
        description: 'The template to apply third',
        type: 'STRING',
        required: false,
        autocomplete: true
      }, {
        name: 'modifier4',
        description: 'The template to apply fourth',
        type: 'STRING',
        required: false,
        autocomplete: true
      }, {
        name: 'modifier5',
        description: 'The template to apply fifth',
        type: 'STRING',
        required: false,
        autocomplete: true
      }]
    }, {
      name: 'attachment',
      description: 'Add a template to a file',
      type: 'SUB_COMMAND',
      options: [{
        name: 'attachment',
        description: 'The image to add the template to',
        type: 'ATTACHMENT',
        required: true
      }, {
        name: 'modifier1',
        description: 'The template to apply first',
        type: 'STRING',
        required: true,
        autocomplete: true
      }, {
        name: 'modifier2',
        description: 'The template to apply second',
        type: 'STRING',
        required: false,
        autocomplete: true
      }, {
        name: 'modifier3',
        description: 'The template to apply third',
        type: 'STRING',
        required: false,
        autocomplete: true
      }, {
        name: 'modifier4',
        description: 'The template to apply fourth',
        type: 'STRING',
        required: false,
        autocomplete: true
      }, {
        name: 'modifier5',
        description: 'The template to apply fifth',
        type: 'STRING',
        required: false,
        autocomplete: true
      }]
    }, {
      name: 'user',
      description: 'Add a template to a user\'s profile picture',
      type: 'SUB_COMMAND',
      options: [{
        name: 'user',
        description: 'The user whose pic to add the template to',
        type: 'USER',
        required: true
      }, {
        name: 'modifier1',
        description: 'The template to apply first',
        type: 'STRING',
        required: true,
        autocomplete: true
      }, {
        name: 'modifier2',
        description: 'The template to apply second',
        type: 'STRING',
        required: false,
        autocomplete: true
      }, {
        name: 'modifier3',
        description: 'The template to apply third',
        type: 'STRING',
        required: false,
        autocomplete: true
      }, {
        name: 'modifier4',
        description: 'The template to apply fourth',
        type: 'STRING',
        required: false,
        autocomplete: true
      }, {
        name: 'modifier5',
        description: 'The template to apply fifth',
        type: 'STRING',
        required: false,
        autocomplete: true
      }]
    }, {
      name: 'member',
      description: 'Add a template to a member\'s server profile picture',
      type: 'SUB_COMMAND',
      options: [{
        name: 'member',
        description: 'The member whose server pic to add the template to',
        type: 'USER',
        required: true
      }, {
        name: 'modifier1',
        description: 'The template to apply first',
        type: 'STRING',
        required: true,
        autocomplete: true
      }, {
        name: 'modifier2',
        description: 'The template to apply second',
        type: 'STRING',
        required: false,
        autocomplete: true
      }, {
        name: 'modifier3',
        description: 'The template to apply third',
        type: 'STRING',
        required: false,
        autocomplete: true
      }, {
        name: 'modifier4',
        description: 'The template to apply fourth',
        type: 'STRING',
        required: false,
        autocomplete: true
      }, {
        name: 'modifier5',
        description: 'The template to apply fifth',
        type: 'STRING',
        required: false,
        autocomplete: true
      }]
    }]
  };
  const helpCommand = {
    name: 'help',
    description: 'List the templates available'
  };

  const toAdd = [helpCommand, templateCommand];

  await disc.application.commands.set(toAdd);
});

client.on(Constants.Events.INTERACTION_CREATE, async interaction => {
  if (interaction.isApplicationCommand()) {
    const event = interaction;
    if (event.commandName === 'template') {
      await event.deferReply();
      let emoji;
      if (event.options.getSubcommand() === 'link') {
        const link = event.options.getString('link');
        emoji = {
          url: link,
          ext: link.indexOf('.gif') >= 0 ? 'gif' : 'png'
        };
      } else if (event.options.getSubcommand() === 'emote') {
        const str = event.options.getString('emote');
        // find a discord emote
        const discordEmote = /<(a?):(\w+):(\d+)>/g.exec(str);
        if (discordEmote) {
          const ext = discordEmote[1] === 'a' ? 'gif' : 'png';
          emoji = {
            name: discordEmote[2],
            id: discordEmote[3],
            url: `https://cdn.discordapp.com/emojis/${discordEmote[3]}.${ext}`,
            ext
          };
        } else {
          // find a unicode emoji
          let unicodeEmoji;
          twemoji.parse(str, (name, emoji1) => {
            if (unicodeEmoji) return false;
            unicodeEmoji = {
              name,
              id: name,
              url: `${emoji1.base + emoji1.size}/${name}${emoji1.ext}`,
              ext: emoji1.ext
            };
            return false;
          });
          if (unicodeEmoji) {
            emoji = unicodeEmoji;
          } else {
            event.editReply({
              content: 'Could not find an emoji',
              ephemeral: true
            });
          }
        }
      } else if (event.options.getSubcommand() === 'attachment') {
        const attachment = event.options.getAttachment('attachment');
        emoji = {
          url: attachment.url,
          ext: attachment.url.indexOf('.gif') >= 0 ? 'gif' : 'png'
        };
      } else if (event.options.getSubcommand() === 'user') {
        const user = event.options.getUser('user');
        emoji = {
          url: user.displayAvatarURL({
            format: 'png',
            dynamic: true
          }),
          ext: user.displayAvatarURL({
            format: 'png',
            dynamic: true
          }).indexOf('.gif') >= 0 ? 'gif' : 'png'
        };
      } else if (event.options.getSubcommand() === 'member') {
        const member = event.options.getMember('member');
        emoji = {
          url: member.displayAvatarURL({
            format: 'png',
            dynamic: true
          }),
          ext: member.displayAvatarURL({
            format: 'png',
            dynamic: true
          }).indexOf('.gif') >= 0 ? 'gif' : 'png'
        };
      } else {
        return;
      }

      console.log('Emoji\n', emoji);

      const mod1 = event.options.getString('modifier1');
      const mod2 = event.options.getString('modifier2');
      const mod3 = event.options.getString('modifier3');
      const mod4 = event.options.getString('modifier4');
      const mod5 = event.options.getString('modifier5');

      const comStr = `/${mod1} /${mod2} /${mod3} /${mod4} /${mod5}`.replace('/_', '\\');

      let worker = new Worker('./imagegenerator.js');
      worker.on('message', msg => {
        const path = msg[0];
        const filename = msg[1];
        const textContent = msg[2];
        const messageOptions = path ? {
          content: textContent,
          files: [{
            attachment: path,
            name: filename
          }],
          allowedMentions: { repliedUser: false }
        } : {
          content: textContent,
          allowedMentions: { repliedUser: false }
        };

        event.editReply(messageOptions).then(() => {
          if (path) fs.unlinkSync(path);
          console.log('Message sent!');
          worker = null;
          console.log('Worker destroyed!');
        }).catch(err => {
          if (path) fs.unlinkSync(path);
          event.editReply({
            content: 'Failed to send generated image',
            allowedMentions: { repliedUser: false }
          });
          console.error('Message sending failed: ', err);
          worker = null;
          console.log('Worker destroyed!');
        });
      });
      worker.on('error', err => {
        console.error('Worker error:', err);
        worker = null;
        console.log('Worker destroyed!');
      });
      worker.on('exit', code => {
        console.log('Worker exited with code:', code);
        worker = null;
        console.log('Worker destroyed!');
      });

      let fileLimitMB = 8;
      if (event.guild) {
        switch (event.guild.premiumTier) {
          case 'TIER_3':
            fileLimitMB = 100;
            break;
          case 'TIER_2':
            fileLimitMB = 50;
            break;
          default:
            fileLimitMB = 8;
        }
      }

      const data = {
        emoji,
        text: comStr,
        messageId: `${event.id}`,
        fileLimitMB
      };
      worker.postMessage(data);
    } else if (event.commandName === 'help') {
      event.reply(otherCommands.help);
    }
  } else if (interaction.isAutocomplete()) {
    if (interaction.commandName === 'template') {
      const focusedValue = interaction.options.getFocused();
      const filtered = choices.filter(choice => choice.name.startsWith(focusedValue)).slice(0, 25);
      await interaction.respond(filtered);
    }
  }
});

client.on(Constants.Events.MESSAGE_CREATE, async message => {
  const commandParsed = /^([/\\])(\w+)\b/.exec(message.cleanContent);
  if (commandParsed) {
    const [, direction, command] = commandParsed;

    if (otherCommands[command]) {
      const text = otherCommands[command];
      message.channel.send(direction === '\\' ? reverseString(text) : text);
      return;
    }
  }

  if (message.cleanContent[0] === '/' || message.cleanContent[0] === '\\') {
    const emoji = await findEmoji(message);
    try {
      if (emoji) {
        let worker = new Worker('./imagegenerator.js');
        worker.on('message', msg => {
          const path = msg[0];
          const filename = msg[1];
          const textContent = msg[2];
          const messageOptions = path ? {
            content: textContent,
            files: [{
              attachment: path,
              name: filename
            }],
            allowedMentions: { repliedUser: false }
          } : {
            content: textContent,
            allowedMentions: { repliedUser: false }
          };

          message.reply(messageOptions).then(() => {
            if (path) fs.unlinkSync(path);
            console.log('Message sent!');
            worker = null;
            console.log('Worker destroyed!\n');
          }).catch(err => {
            if (path) fs.unlinkSync(path);
            message.reply({
              content: 'Failed to send generated image',
              allowedMentions: { repliedUser: false }
            });
            console.error('Message sending failed: ', err);
            worker = null;
            console.log('Worker destroyed!\n');
          });
        });
        worker.on('error', err => {
          console.error('Worker error:', err);
          worker = null;
          console.log('Worker destroyed!\n');
        });
        worker.on('exit', code => {
          console.log('Worker exited with code:', code);
          worker = null;
          console.log('Worker destroyed!\n');
        });

        let fileLimitMB;
        switch (message.guild.premiumTier) {
          case 'TIER_3':
            fileLimitMB = 100;
            break;
          case 'TIER_2':
            fileLimitMB = 50;
            break;
          default:
            fileLimitMB = 8;
        }
        // console.log(`Guild tier: ${message.guild.premiumTier}\nFile size limit: ${fileLimitMB}MB`);

        const data = {
          emoji,
          text: message.cleanContent,
          messageId: `${message.id}`,
          fileLimitMB
        };
        worker.postMessage(data);
      }
    } catch (err) {
      console.error('Error in main:', err);
    }
  }
});
