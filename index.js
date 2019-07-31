import dotenv from 'dotenv';
import format from 'string-format';
import Telegraf from 'telegraf';
import Agent from 'socks5-https-client/lib/Agent';
import Stage from 'telegraf/stage';
import Scene from 'telegraf/scenes/base';
import session from 'telegraf/session';

import { 
    SEXES,
    SEXES_WITH_ANY,
    CHAT_TYPES,
    BOOLEANS,
    BOOLEANS_WITH_ANY,
    TASK_FINISHED_STATUSES
} from './constants';
import { state, users, tasks, DBInstanceNotFoundError } from './database';
import { sendMessageToUsers } from './helpers';

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN, {
    telegram: {
        agent: new Agent({
            socksHost: process.env.PROXY_HOST,
            socksPort: parseInt(process.env.PROXY_PORT),
        }),
    }
});

const stage = new Stage()
const getSex = new Scene('getSex');
const getLightAlco = new Scene('getLightAlco');
const getMiddleAlco = new Scene('getMiddleAlco');
const getHardAlco = new Scene('getHardAlco');
const getWithPartner = new Scene('getWithPartner');
const getPartyHard = new Scene('getPartyHard');
const regFinished = new Scene('regFinished');
const adminScene = new Scene('adminScene');
const getTaskDescription = new Scene('getTaskDescription');
const getTaskChatType = new Scene('getTaskChatType');
const getTaskSex = new Scene('getTaskSex');
const getTaskWithPartner = new Scene('getTaskWithPartner');
let isPolling = false;

stage.register(getSex);
stage.register(getLightAlco);
stage.register(getMiddleAlco);
stage.register(getHardAlco);
stage.register(getWithPartner);
stage.register(getPartyHard);
stage.register(regFinished);
stage.register(adminScene);
stage.register(getTaskDescription);
stage.register(getTaskChatType);
stage.register(getTaskSex);
stage.register(getTaskWithPartner);

bot.use(session())
bot.use(stage.middleware());

bot.use(async (ctx, next, ...args) => {
    try {
        await next(ctx);
    } catch (e) {
        console.error(e);
        sendMessageToUsers(await users.getAdmins(), `ERROR: ${JSON.stringify(e.message, null, 4)}`, bot);
    }
});

bot.catch(async (e) => {
    console.error(e);
    sendMessageToUsers(await users.getAdmins(), `ERROR: ${JSON.stringify(e.message, null, 4)}`, bot);
});


bot.start(async (ctx) => {
    const {update: {message: {from, from: {username}, chat: {id, type}}}} = ctx;
    let user = null;

    try {
        user = await users.getUser(username);
    } catch (e) {
        if (!(e instanceof DBInstanceNotFoundError)) {
            throw e;
        }
    }

    console.log(type)

    if (type === 'group') {
        if (user) {
            if (user.admin) {
                await state.updateChatId(id);
            }
            return await ctx.reply(
                `Привет @${username} \n` +
                `Вот доступные команды: \n` +
                `/playtask - выдать таск рандомному пользователю \n` +
                `/playprivatetask - выдать таск рандомному пользователю в личку (никто не будет знать что за таск) \n` +
                `/playtaskforme - выдать таск себе \n` + 
                `/rating - лидерборд \n` +
                `/drink - с назначенным человеком ты должен выпить \n` +
                `Когда вам будет назначен таск, в личку к вам придет отбивка с самим заданием`
            );
        }
        return ctx.replyWithMarkdown(
            JSON.stringify(users[username]) || `*@${username}* напиши мне /start в лс, а то не сможешь поиграть :)`
        );
    }

    if (user) {
        await ctx.reply(`Привет @${username}`)
    
        ctx.session.user = user;

        if (user.admin) {
            return ctx.scene.enter('adminScene');
        }

        return ctx.scene.enter('regFinished');
    }

    ctx.reply(
        'Выбери свой пол?',
        {reply_markup: {keyboard: [Object.values(SEXES)]}}
    );

    ctx.session.user = {...from, chatId: from.id, rating: 0};
    ctx.scene.enter('getSex');
});


async function playTask(ctx, chatType) {
    const {update: {message: {chat: {type}}}} = ctx;

    if (type !== 'group') {
        return ctx.reply('Данная команда доступна только для группы');
    }

    const currentTaskId = await state.getCurrentTaskId();

    if (currentTaskId) {
        return ctx.reply('В данный момент уже выдано задание');
    }

    const suitableTasks = await tasks.filterItems({approved: true, chatType});
    const randomTask = suitableTasks[Math.round(Math.random() * (suitableTasks.length - 1))];

    if (!randomTask) {
        return ctx.reply('Не нашлось подходящего  таска, попробуй еще раз =(');
    }
    
    const userFields = ['sex', 'lightAlco', 'middleAlco', 'hardAlco', 'withPartner'];
    const query = userFields.reduce((acc, field) => {
        if ([BOOLEANS_WITH_ANY.any, SEXES_WITH_ANY.any, undefined].includes(randomTask[field])) {
            return acc;
        }

        return {...acc, [field]: randomTask[field]};
    }, {});

    if (randomTask.level > 1) {
        query.partyHard = BOOLEANS.yes;
    }
    
    const suitableUsers = Object.keys(query).length ? await users.filterItems(query) : await users.getAll();

    if (!suitableUsers.length) {
        return ctx.reply('Не нашлось подходящего человека под случайно выбранный таск, попробуй еще раз =(');
    }

    await state.updateCurrentTaskId(randomTask.id);

    const user = suitableUsers[Math.round(Math.random() * (suitableUsers.length - 1))];

    await state.updateCurrentUserId(user.id);

    const message = `@${user.username} для тебя задание. Автор: @${randomTask.username} \n` +
        `${randomTask.description} \n` + 
        `После того как закончишь пиши /taskfinish, а остальные тебя оценят :)`;

    if (randomTask.chatType === CHAT_TYPES.private) {
        ctx.telegram.sendMessage(user.chatId, message);
        sendMessageToUsers(await users.getAdmins(), `По секрету скажу что задание выдано @${user.username}`, ctx);

        return ctx.reply('Задание успешно выдано :)');
    }

    ctx.reply(message);
}

bot.command(new RegExp('rating(@.*)?'), async (ctx) => {
    const allUsers = await users.getAll();

    return ctx.reply(`Лидерборд: \n ${allUsers.sort((a, b) => a.rating - b.rating).map(user => `${user.username} - ${user.rating}`).join('\n')}`);
});

bot.hears(new RegExp('/playtask(@.*)?'), async (ctx) => {
    await playTask(ctx, CHAT_TYPES.public);
});

bot.hears(new RegExp('/playprivatetask(@.*)?'), async (ctx) => {
    await playTask(ctx, CHAT_TYPES.private);
});

bot.hears(new RegExp('/taskfinish(@.*)?'), async (ctx) => {
    const {update: {message: {from}}} = ctx;
    const user = await users.getItem({chatId: from.id});

    const taskId = await state.getCurrentTaskId();
    const userId = await state.getCurrentUserId();

    if (taskId === null) return ctx.reply('Сейчас нет текущего задания');
    if (userId === null) return ctx.reply('Сейчас никто не проходит задание');

    const chatId = await state.getChatId();
    const task = await tasks.getItemById(taskId);
    const taskUser = await users.getItemById(userId);

    if (user.id !== taskUser.id && !user.admin) {
        return ctx.reply('Сори, но ты не можешь завершить задание :)');
    }

    if (isPolling) return ctx.reply('Уже идет голосование');

    const message = `@${user.username} только что закончил свое задание, давайте его оценим. У вас есть {} сек. ` +
        `Напоминаю, что текст задания был такой: \n ${task.description}`;
    const sec = 15;

    const {message_id: messageId} = await ctx.telegram.sendMessage(chatId, format(message, sec));

    isPolling = true;

    const {message_id: pollMessageId} = await ctx.telegram.sendPoll(chatId, `Как ${user.username} справился с заданием?`, Object.values(TASK_FINISHED_STATUSES));
    await new Promise((resolve) => {
        let now = +new Date();
        const endTime = now + sec * 1000;

        const timerId = setInterval(() => {
            now = +new Date();

            ctx.telegram.editMessageText(chatId, messageId, messageId, format(message, Math.round((endTime - now) / 1000)));
        }, 5000)
        setTimeout(() => {
            clearInterval(timerId);
            resolve();
        }, sec * 1000);
    });

    await ctx.telegram.editMessageText(chatId, messageId, messageId, format(message, 0));
    const {options: pollResults} = await ctx.telegram.stopPoll(chatId, pollMessageId);
    let points = 0;

    for (let result of pollResults) {
        switch (result.text) {
            case TASK_FINISHED_STATUSES.PERFECT:
                points += 2 * result.voter_count * task.level * task.rating;
                break;
            case TASK_FINISHED_STATUSES.NORMAL:
                points += result.voter_count * task.level * task.rating;
                break;
        }
    }

    ctx.telegram.sendMessage(chatId, `Ура! ${user.username} получает ${points} к рейтингу!`);

    taskUser.rating += points;
    taskUser.save();

    isPolling = false;
    await state.updateCurrentTaskId(null);
    await state.updateCurrentUserId(null);
});

getSex.hears(Object.values(SEXES), async (ctx) => {
    const {session: {user}, update: {message: {text}}} = ctx;

    user.sex = text;

    await ctx.scene.leave('getSex');

    ctx.reply(
        'Пьешь некрепкое? (~6 градусов)',
        {reply_markup: {keyboard: [Object.values(BOOLEANS)]}}
    );

    ctx.scene.enter('getLightAlco');
});
  
getLightAlco.hears(Object.values(BOOLEANS), async (ctx) => {
    const {session: {user}, update: {message: {text}}} = ctx;

    user.lightAlco = text;

    await ctx.scene.leave('getLightAlco');

    ctx.reply(
        'Пьешь среднее по крепости? (~20 градусов)',
        {reply_markup: {keyboard: [Object.values(BOOLEANS)]}}
    );

    ctx.scene.enter('getMiddleAlco');
});

getMiddleAlco.hears(Object.values(BOOLEANS), async (ctx) => {
    const {session: {user}, update: {message: {text}}} = ctx;

    user.middleAlco = text;

    await ctx.scene.leave('getMiddleAlco');

    ctx.reply(
        'Пьешь крепкое? (~40 градусов)',
        {reply_markup: {keyboard: [Object.values(BOOLEANS)]}}
    );

    ctx.scene.enter('getHardAlco');
});

getHardAlco.hears(Object.values(BOOLEANS), async (ctx) => {
    const {session: {user}, update: {message: {text}}} = ctx;

    user.hardAlco = text;

    await ctx.scene.leave('getHardAlco');

    ctx.reply(
        `У тебя есть партнер?`,
        {reply_markup: {keyboard: [Object.values(BOOLEANS)]}}
    );

    ctx.scene.enter('getWithPartner');
});

getWithPartner.hears(Object.values(BOOLEANS), async (ctx) => {
    const {session: {user}, update: {message: {text}}} = ctx;

    user.withPartner = text;

    await ctx.scene.leave('getWithPartner');

    ctx.reply(
        `Готов${user.sex === SEXES.female ? 'а' : ''} оторваться? (Могут попасться жесткие задачи)`,
        {reply_markup: {keyboard: [Object.values(BOOLEANS)]}}
    );

    ctx.scene.enter('getPartyHard');
});

getPartyHard.hears(Object.values(BOOLEANS), async (ctx) => {
    const {session, update: {message: {text}}} = ctx;
    let {session: {user}} = ctx;

    user.partyHard = text;

    await ctx.scene.leave('getPartyHard');
    await ctx.reply(`${text === BOOLEANS.yes 
        ? 'Отлично!' 
        : 'Жаль..'
    } В течение вечеринки в общем чате будут появляться задания и общие игры, ${
        text === BOOLEANS.yes 
            ? 'вруби звук, чтобы не упустить момент!' 
            : 'Я постараюсь выдавать тебе не слишком жесткие задания'
    }`, {reply_markup: {remove_keyboard: true}});

    user = await users.addUser(user);

    session.user = user;

    await ctx.reply('Ты в игре! Если хочешь предложить задание - пиши /newtask. Для списка всех команд пиши - /help');

    ctx.scene.enter('regFinished');
});

regFinished.hears('/register', register);

async function register(ctx) {
    const {session: {user}, message: {from}} = ctx;

    await ctx.scene.leave('regFinished');

    if (user && user.remove) {
        await user.remove();
    }

    ctx.reply(
        'Выбери свой пол?',
        {reply_markup: {keyboard: [Object.values(SEXES)]}}
    );
    ctx.session.user = {...from, chatId: from.id, rating: 0};
    ctx.scene.enter('getSex');
}

regFinished.hears('/registeradmin', async (ctx) => {
    const {session: {user}} = ctx;

    user.admin = true;

    await user.save();

    ctx.scene.enter('adminScene');
    await ctx.reply('Супер теперь ты Админ', {reply_markup: {remove_keyboard: true}});
});

regFinished.hears('/help', async (ctx) => {
    ctx.reply('/newtask - предложить задание\n');
});

regFinished.hears('/newtask', async (ctx) => {
    const {session} = ctx;

    session.task = {
        username: session.user.username
    };

    await ctx.replyWithMarkdown('**Какое описание задания?**', {reply_markup: {remove_keyboard: true}});
    ctx.scene.enter('getTaskDescription');
});

adminScene.hears('/newtask', async (ctx) => {
    const {session} = ctx;

    session.task = {
        userChatId: session.user.chatId,
        userId: session.user.id,
        username: session.user.username
    };

    await ctx.replyWithMarkdown('**Какое описание задания?**', {reply_markup: {remove_keyboard: true}});
    ctx.scene.enter('getTaskDescription');
});



getTaskDescription.on('text', async (ctx) => {
    const {session: {task}, update: {message: {text}}} = ctx;
    await ctx.scene.leave('getTaskDescription');
    await ctx.replyWithMarkdown('**Данное задание кидать в общий чат или личку?**', {reply_markup: {
        keyboard: [
            Object.values(CHAT_TYPES)
        ]
    }});
    
    task.description = text;
    ctx.scene.enter('getTaskChatType');
});

getTaskChatType.hears(Object.values(CHAT_TYPES), async (ctx) => {
    const {session: {task}, update: {message: {text}}} = ctx;
    await ctx.scene.leave('getTaskChatType');
    await ctx.replyWithMarkdown('**Для какого пола?**', {reply_markup: {
        keyboard: [
            Object.values(SEXES_WITH_ANY)
        ]
    }});
    
    task.chatType = text;
    ctx.scene.enter('getTaskSex');
});

getTaskSex.hears(Object.values(SEXES_WITH_ANY), async (ctx) => {
    const {session: {task}, update: {message: {text}}} = ctx;
    await ctx.scene.leave('getTaskSex');
    await ctx.replyWithMarkdown('**Для тех у кого есть партнер?**', {reply_markup: {
        keyboard: [
            Object.values(BOOLEANS_WITH_ANY)
        ]
    }});
    
    task.sex = text;
    ctx.scene.enter('getTaskWithPartner');
});

getTaskWithPartner.hears(Object.values(BOOLEANS_WITH_ANY), async (ctx) => {
    const {session: {user}, update: {message: {text}}} = ctx;

    let {session: {task}} = ctx;

    await ctx.scene.leave('getTaskWithPartner');
    await ctx.reply('Отлично твое задание на модерации', {reply_markup: {remove_keyboard: true}});
    
    task.withPartner = text;
    task.rating = 5;
    task.level = 1;
    task.lightAlco = BOOLEANS_WITH_ANY.any;
    task.middleAlco = BOOLEANS_WITH_ANY.any;
    task.hardAlco = BOOLEANS_WITH_ANY.any;

    task = await tasks.addTask(task);

    sendMessageToUsers(
        await users.getAdmins(), 
        `Добавлено новое задание: \n ${JSON.stringify(task, null, 4)}\n` +
        `Инфо - /task${task.id} \n` +
        `Апрув - /approve${task.id} \n` +
        `Рейтинг - /setRating${task.id} \n` +
        `Уровень - /setLevel${task.id} \n` +
        `Отказ - /reject${task.id} \n` +
        `Партнер - /setPartner${task.id} \n` +
        `Пол - /setSex${task.id} \n` +
        `Приватный - /setChatType${task.id} \n` +
        `Можно с пивом - /setLightAlco${task.id} \n` +
        `Можно с вином - /setMiddleAlco${task.id} \n` +
        `Можно с водкой - /setHardAlco${task.id} \n`,
        ctx
    );

    if (user.admin) {
        return ctx.scene.enter('adminScene');
    }

    ctx.scene.enter('regFinished');
});

adminScene.hears('/tasks', async (ctx) => {
    const tasksList = await tasks.getAll();

    ctx.replyWithMarkdown(tasksList.map(task => `${
        task.approved ? '+' : '-'} **${task.id}:** ${
        task.description} ${task.username
    }`).join('\n'), {reply_markup: {remove_keyboard: true}});
});

adminScene.hears(new RegExp('/approve(\\d+)'), async (ctx) => {
    const {match} = ctx;
    const id = Number(match[1]);
    const task = await tasks.getItemById(id);

    task.approved = true;
    task.save();
    
    await ctx.reply('DONE', {reply_markup: {remove_keyboard: true}});
});


adminScene.hears(new RegExp('/reject(\\d+)'), async (ctx) => {
    const {match} = ctx;
    const id = Number(match[1]);
    const task = await tasks.getItemById(id);

    task.approved = false;
    task.save();
    
    await ctx.reply('DONE', {reply_markup: {remove_keyboard: true}});
});

adminScene.hears(new RegExp('/setRating(\\d+) (\\d+)'), async (ctx) => {
    const {match} = ctx;
    const id = Number(match[1]);
    const rating = Number(match[2]);
    const task = await tasks.getItemById(id);

    task.rating = rating;
    task.save();
    
    await ctx.reply('DONE', {reply_markup: {remove_keyboard: true}});
});

adminScene.hears(new RegExp('/setLevel(\\d+) (\\d+)'), async (ctx) => {
    const {match} = ctx;
    const id = Number(match[1]);
    const level = Number(match[2]);
    const task = await tasks.getItemById(id);

    task.level = level;
    task.save();
    
    await ctx.reply('DONE', {reply_markup: {remove_keyboard: true}});
});

adminScene.hears(new RegExp(`/setPartner(\\d+) (${Object.values(BOOLEANS_WITH_ANY).join('|')})`), async (ctx) => {
    const {match} = ctx;
    const id = Number(match[1]);
    const withPartner = match[2];
    const task = await tasks.getItemById(id);

    task.withPartner = withPartner;
    task.save();
    
    await ctx.reply('DONE', {reply_markup: {remove_keyboard: true}});
});

adminScene.hears(new RegExp(`/setSex(\\d+) (${Object.values(SEXES_WITH_ANY).join('|')})`), async (ctx) => {
    const {match} = ctx;
    const id = Number(match[1]);
    const sex = match[2];
    const task = await tasks.getItemById(id);

    task.sex = sex;
    task.save();
    
    await ctx.reply('DONE', {reply_markup: {remove_keyboard: true}});
});


adminScene.hears(new RegExp(`/setChatType(\\d+) (${Object.values(CHAT_TYPES).join('|')})`), async (ctx) => {
    const {match} = ctx;
    const id = Number(match[1]);
    const chatType = match[2];
    const task = await tasks.getItemById(id);

    task.chatType = chatType;
    task.save();
    
    await ctx.reply('DONE', {reply_markup: {remove_keyboard: true}});
});

adminScene.hears(new RegExp(`/setLightAlco(\\d+) (${Object.values(BOOLEANS_WITH_ANY).join('|')})`), async (ctx) => {
    const {match} = ctx;
    const id = Number(match[1]);
    const lightAlco = match[2];
    const task = await tasks.getItemById(id);

    task.lightAlco = lightAlco;
    task.save();
    
    await ctx.reply('DONE', {reply_markup: {remove_keyboard: true}});
});

adminScene.hears(new RegExp(`/setMiddleAlco(\\d+) (${Object.values(BOOLEANS_WITH_ANY).join('|')})`), async (ctx) => {
    const {match} = ctx;
    const id = Number(match[1]);
    const middleAlco = match[2];
    const task = await tasks.getItemById(id);

    task.middleAlco = middleAlco;
    task.save();
    
    await ctx.reply('DONE', {reply_markup: {remove_keyboard: true}});
});


adminScene.hears(new RegExp(`/setHardAlco(\\d+) (${Object.values(BOOLEANS_WITH_ANY).join('|')})`), async (ctx) => {
    const {match} = ctx;
    const id = Number(match[1]);
    const hardAlco = match[2];
    const task = await tasks.getItemById(id);

    task.hardAlco = hardAlco;
    task.save();
    
    await ctx.reply('DONE', {reply_markup: {remove_keyboard: true}});
});

adminScene.hears('/resetTask', async (ctx) => {
    const currentTaskId = await state.getCurrentTaskId();

    await state.updateCurrentTaskId(null);
    await state.updateCurrentUserId(null);
    await ctx.reply(`Task ${currentTaskId} has been reseted`, {reply_markup: {remove_keyboard: true}});
});

adminScene.hears(new RegExp('/task(\\d+)'), async (ctx) => {
    const {match} = ctx;
    const id = Number(match[1]);
    const task = await tasks.getItemById(id);

    await ctx.reply(`${JSON.stringify(task, null, 4)} ` +
        `Инфо - /task${task.id} \n` +
        `Апрув - /approve${task.id} \n` +
        `Рейтинг - /setRating${task.id} \n` +
        `Уровень - /setLevel${task.id} \n` +
        `Отказ - /reject${task.id} \n` +
        `Партнер - /setPartner${task.id} \n` +
        `Пол - /setSex${task.id} \n` +
        `Приватный - /setChatType${task.id} \n` +
        `Можно с пивом - /setLightAlco${task.id} \n` +
        `Можно с вином - /setMiddleAlco${task.id} \n` +
        `Можно с водкой - /setHardAlco${task.id} \n`,
        {reply_markup: {remove_keyboard: true}}
    );
});

regFinished.on('text', async (ctx) => {
    ctx.reply('Ты уже в игре, переходи в общий чат. Если хочешь перерегестрироваться, пиши /register', {reply_markup: {remove_keyboard: true}});
});

console.log('launched');
bot.startPolling();