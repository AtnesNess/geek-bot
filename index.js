import Scene from 'telegraf/scenes/base';
import Stage from 'telegraf/stage';
import Telegraf from 'telegraf';
import dotenv from 'dotenv';
import format from 'string-format';
import get from 'lodash/get';
import got from 'got';
import http from 'http';
import session from 'telegraf/session';
import throttle from 'lodash/throttle';

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

const bot = new Telegraf(process.env.BOT_TOKEN);

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

function getUserName(user) {
    if (!user) {
        return 'Unmentioned';
    }
    return `[${user.first_name} ${user.last_name}](tg://user?id=${user.chatId || user.id})`;
}

const wakeUp = throttle(async () => {
    console.log('wakeUp');
    if (process.env.WAKEUP_HOST) {
        await got(process.env.WAKEUP_HOST);
    }
}, 25 * 60 * 1000);

bot.use(async (ctx, next, ...args) => {
    try {
        await wakeUp();
  
        ctx.userMention = getUserName(get(ctx, 'update.message.from'));

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


async function printHelp(ctx) {
    return await ctx.replyWithMarkdown(
        `Вот доступные команды: \n` +
        `/newtask - предложить задание (в личку боту) \n` + 
        `/playtask - выдать таск рандомному пользователю \n` +
        `/playprivatetask - выдать таск рандомному пользователю в личку (никто не будет знать что за таск) \n` +
        `/playtaskforme - выдать таск себе \n` + 
        `/rating - лидерборд \n` +
        `/drinkBeer - с назначенным человеком ты должен выпить пиво\n` +
        `/drinkWine - с назначенным человеком ты должен выпить винчик\n` +
        `/drinkVodka - с назначенным человеком ты должен выпить крепкий алкоголь\n` +
        `/pidor - Найти пидора часа\n` +
        `/awesome - Найти красавчика часа\n` +
        `/singles - список участников без пары \n` +
        `Когда вам будет назначен таск, в личку к вам придет отбивка с самим заданием \n` +
        'Если я не отвечаю на ваши команды, значит я уснул - перейди на https://atnes-geek-party-bot.herokuapp.com/ и я проснусь'
    );
}

bot.start(async (ctx) => {
    const {update: {message: {from, from: {id: userChatId}, chat: {id, type}}}} = ctx;
    
    let user = null;

    try {
        user = await users.getUser(userChatId);
    } catch (e) {
        if (!(e instanceof DBInstanceNotFoundError)) {
            throw e;
        }
    }

    if (type === 'group') {
        if (user) {
            if (user.admin) {
                await state.updateChatId(id);
            }
            return await printHelp(ctx);
        }
        return ctx.replyWithMarkdown(
            `${ctx.userMention} напиши мне /start в лс, а то не сможешь поиграть :)`
        );
    }

    if (user) {
        await ctx.replyWithMarkdown(`Привет ${ctx.userMention}`)
    
        ctx.session.user = user;

        if (user.admin) {
            return ctx.scene.enter('adminScene');
        }

        return ctx.scene.enter('regFinished');
    }

    register(ctx);
});

bot.hears(new RegExp('/help(@.*)?'), printHelp);

function register(ctx) {
    const {update: {message: {from}}} = ctx;

    ctx.replyWithMarkdown(
        'Выбери свой пол?',
        {reply_markup: {keyboard: [Object.values(SEXES)]}}
    );

    ctx.session.user = {...from, playing: true, mention: ctx.userMention, chatId: from.id, rating: 0};
    ctx.scene.enter('getSex');
}

async function playTaskForUser(ctx, user, chatType) {
    const {update: {message: {chat: {type}}}} = ctx;

    if (type !== 'group') {
        return ctx.replyWithMarkdown('Данная команда доступна только для группы');
    }

    const currentTaskId = await state.getCurrentTaskId();

    if (currentTaskId) {
        return ctx.replyWithMarkdown('В данный момент уже выдано задание');
    }

    const userBoolFields = ['lightAlco', 'middleAlco', 'hardAlco', 'withPartner'];
    const query = userBoolFields.reduce((acc, field) => {
        return {...acc, [field]: [user[field], BOOLEANS_WITH_ANY.any]};
    }, {});
    query.sex = [user.sex, SEXES_WITH_ANY.any];

    if (user.partyHard !== BOOLEANS.yes) {
        query.level = 1;
    }

    query.approved = true;

    if (chatType) {
        query.chatType = chatType;
    }

    const suitableTasks = await tasks.filterItems(query);
    const randomTask = suitableTasks[Math.round(Math.random() * (suitableTasks.length - 1))];

    if (!randomTask) {
        return ctx.replyWithMarkdown('Не нашлось подходящего таска, попробуй еще раз =(');
    }
    
    await state.updateCurrentTaskId(randomTask.id);
    await state.updateCurrentUserId(user.id);

    const message = `${user.mention} для тебя задание. Автор: @${randomTask.userMention} \n` +
        `${randomTask.description} \n` + 
        `После того как закончишь пиши /taskfinish, а остальные тебя оценят :)`;

    if (randomTask.chatType === CHAT_TYPES.private) {
        ctx.telegram.sendMessage(user.chatId, message, {parse_mode: 'Markdown'});
        sendMessageToUsers(await users.getAdmins(), `По секрету скажу что задание выдано @${user.mention}`, ctx);

        return ctx.replyWithMarkdown('Задание успешно выдано :)');
    }

    await ctx.replyWithMarkdown(message);
}

async function playTask(ctx, chatType) {
    const suitableUsers = await users.filterItems({playing: true});
    const randomUser = suitableUsers[Math.round(Math.random() * (suitableUsers.length - 1))];

    await playTaskForUser(ctx, randomUser, chatType);
}

bot.hears(new RegExp('/drinkBeer(@.*)?'), async (ctx) => {
    const {update: {message: {chat: {type}}}} = ctx;

    if (type !== 'group') {
        return ctx.replyWithMarkdown('Данная команда доступна только для группы');
    }

    const suitableUsers = await users.filterItems({playing: true, lightAlco: BOOLEANS.yes});
    const randomUser = suitableUsers[Math.round(Math.random() * (suitableUsers.length - 1))];
    
    if (!randomUser) {
        return ctx.replyWithMarkdown('Никто не пьет пиво =(');
    }

    return ctx.replyWithMarkdown(`${ctx.userMention} Выпей пива с ${randomUser.mention}!`);
});

bot.hears(new RegExp('/drinkWine(@.*)?'), async (ctx) => {
    const {update: {message: {chat: {type}}}} = ctx;

    if (type !== 'group') {
        return ctx.replyWithMarkdown('Данная команда доступна только для группы');
    }

    const suitableUsers = await users.filterItems({playing: true, middleAlco: BOOLEANS.yes});
    const randomUser = suitableUsers[Math.round(Math.random() * (suitableUsers.length - 1))];

    if (!randomUser) {
        return ctx.replyWithMarkdown('Никто не пьет вино =(');
    }

    return ctx.replyWithMarkdown(`${ctx.userMention} Выпей винчика с ${randomUser.mention}!`);
});

bot.hears(new RegExp('/drinkVodka(@.*)?'), async (ctx) => {
    const {update: {message: {chat: {type}}}} = ctx;

    if (type !== 'group') {
        return ctx.replyWithMarkdown('Данная команда доступна только для группы');
    }

    const suitableUsers = await users.filterItems({playing: true, hardAlco: BOOLEANS.yes});
    const randomUser = suitableUsers[Math.round(Math.random() * (suitableUsers.length - 1))];

    if (!randomUser) {
        return ctx.replyWithMarkdown('Никто не пьет водку =(');
    }

    return ctx.replyWithMarkdown(`${ctx.userMention} Выпей водки с ${randomUser.mention}! Za zdorovye!`);
});

bot.hears(new RegExp('/pidor(@.*)?'), async (ctx) => {
    const {update: {message: {chat: {type}}}} = ctx;

    if (type !== 'group') {
        return ctx.replyWithMarkdown('Данная команда доступна только для группы');
    }

    const pidorDate = await state.getPidorDate();

    if (new Date() - pidorDate < 60 * 60 * 1000) {
        return ctx.replyWithMarkdown('Пидор часа уже найден');
    }

    return await findPidor();
});

bot.hears(new RegExp('/awesome(@.*)?'), async (ctx) => {
    const {update: {message: {chat: {type}}}} = ctx;

    if (type !== 'group') {
        return ctx.replyWithMarkdown('Данная команда доступна только для группы');
    }

    const awesomeDate = await state.getAwesomeDate();

    if (new Date() - awesomeDate < 60 * 60 * 1000) {
        return ctx.replyWithMarkdown('Красавчик часа уже найден');
    }

    return await findPretty();
});

bot.hears(new RegExp('/singles(@.*)?'), async (ctx) => {
    const singles = await users.filterItems({withPartner: BOOLEANS.no});

    return ctx.replyWithMarkdown(`Эти участники одиноки: \n${singles.map(user => user.mention).join('\n')}`);
});

bot.hears(new RegExp('/rating(@.*)?'), async (ctx) => {
    const allUsers = await users.getAll();

    return ctx.replyWithMarkdown(`Лидерборд: \n ${allUsers.sort((a, b) => a.rating - b.rating).map(user => `${user.mention} - ${user.rating}`).join('\n')}`);
});

bot.hears(new RegExp('/playtaskforme(@.*)?'), async (ctx) => {
    const {update: {message: {from}}} = ctx;
    const user = await users.getItem({chatId: from.id});
    
    await playTaskForUser(ctx, user);
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

    if (taskId === null) return ctx.replyWithMarkdown('Сейчас нет текущего задания');
    if (userId === null) return ctx.replyWithMarkdown('Сейчас никто не проходит задание');

    const chatId = await state.getChatId();
    const task = await tasks.getItemById(taskId);
    const taskUser = await users.getItemById(userId);

    if (user.id !== taskUser.id && !user.admin) {
        return ctx.replyWithMarkdown('Сори, но ты не можешь завершить задание :)');
    }

    if (isPolling) return ctx.replyWithMarkdown('Уже идет голосование');

    const message = `${user.mention} только что закончил свое задание, давайте его оценим. У вас есть {} сек. ` +
        `Напоминаю, что текст задания был такой: \n ${task.description}`;
    const sec = 60;

    const {message_id: messageId} = await ctx.telegram.sendMessage(chatId, format(message, sec), {parse_mode: 'Markdown'});

    isPolling = true;

    const {message_id: pollMessageId} = await ctx.telegram.sendPoll(chatId, `Как ${user.first_name} ${user.last_name} справился с заданием?`, Object.values(TASK_FINISHED_STATUSES));
    await new Promise((resolve) => {
        let now = +new Date();
        const endTime = now + sec * 1000;

        const timerId = setInterval(() => {
            now = +new Date();

            ctx.telegram.editMessageText(chatId, messageId, messageId, format(message, Math.round((endTime - now) / 1000)), {parse_mode: 'Markdown'});
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

    ctx.telegram.sendMessage(chatId, `Ура! ${user.mention} получает ${points} к рейтингу!`, {parse_mode: 'Markdown'});

    taskUser.rating += points;
    taskUser.save();

    isPolling = false;
    await state.updateCurrentTaskId(null);
    await state.updateCurrentUserId(null);

    await printHelp(ctx);
});

getSex.hears(Object.values(SEXES), async (ctx) => {
    const {session: {user}, update: {message: {text}}} = ctx;

    user.sex = text;

    await ctx.scene.leave('getSex');

    ctx.replyWithMarkdown(
        'Пьешь некрепкое? (~6 градусов)',
        {reply_markup: {keyboard: [Object.values(BOOLEANS)]}}
    );

    ctx.scene.enter('getLightAlco');
});
  
getLightAlco.hears(Object.values(BOOLEANS), async (ctx) => {
    const {session: {user}, update: {message: {text}}} = ctx;

    user.lightAlco = text;

    await ctx.scene.leave('getLightAlco');

    ctx.replyWithMarkdown(
        'Пьешь среднее по крепости? (~20 градусов)',
        {reply_markup: {keyboard: [Object.values(BOOLEANS)]}}
    );

    ctx.scene.enter('getMiddleAlco');
});

getMiddleAlco.hears(Object.values(BOOLEANS), async (ctx) => {
    const {session: {user}, update: {message: {text}}} = ctx;

    user.middleAlco = text;

    await ctx.scene.leave('getMiddleAlco');

    ctx.replyWithMarkdown(
        'Пьешь крепкое? (~40 градусов)',
        {reply_markup: {keyboard: [Object.values(BOOLEANS)]}}
    );

    ctx.scene.enter('getHardAlco');
});

getHardAlco.hears(Object.values(BOOLEANS), async (ctx) => {
    const {session: {user}, update: {message: {text}}} = ctx;

    user.hardAlco = text;

    await ctx.scene.leave('getHardAlco');

    ctx.replyWithMarkdown(
        `У тебя есть партнер?`,
        {reply_markup: {keyboard: [Object.values(BOOLEANS)]}}
    );

    ctx.scene.enter('getWithPartner');
});

getWithPartner.hears(Object.values(BOOLEANS), async (ctx) => {
    const {session: {user}, update: {message: {text}}} = ctx;

    user.withPartner = text;

    await ctx.scene.leave('getWithPartner');

    ctx.replyWithMarkdown(
        `Готов${user.sex === SEXES.female ? 'а' : ''} оторваться? (Могут попасться жесткие задачи)`,
        {reply_markup: {keyboard: [Object.values(BOOLEANS)]}}
    );

    ctx.scene.enter('getPartyHard');
});

getPartyHard.hears(Object.values(BOOLEANS), async (ctx) => {
    const {userMention, session, update: {message: {text}}} = ctx;
    let {session: {user}} = ctx;

    const chatId = await state.getChatId();

    user.partyHard = text;

    await ctx.scene.leave('getPartyHard');
    await ctx.replyWithMarkdown(`${text === BOOLEANS.yes 
        ? 'Отлично!' 
        : 'Жаль..'
    } В течение вечеринки в общем чате будут появляться задания и общие игры, ${
        text === BOOLEANS.yes 
            ? 'вруби звук, чтобы не упустить момент!' 
            : 'Я постараюсь выдавать тебе не слишком жесткие задания'
    }`, {reply_markup: {remove_keyboard: true}});

    user = await users.addUser(user);

    session.user = user;

    await ctx.replyWithMarkdown('Ты в игре! Если хочешь предложить задание - пиши /newtask. Для списка всех команд пиши - /help');
    ctx.scene.enter('regFinished');
    await ctx.telegram.sendMessage(chatId, `${userMention} теперь в игре!`, {parse_mode: 'Markdown'});
});

regFinished.hears('/register', async (ctx) => {
    const {session: {user}} = ctx;

    await ctx.scene.leave('regFinished');

    if (user && user.remove) {
        await user.remove();
    }

    await register(ctx);
});


regFinished.hears('/registeradmin', async (ctx) => {
    const {session: {user}} = ctx;

    user.admin = true;

    await user.save();

    ctx.scene.enter('adminScene');
    await ctx.replyWithMarkdown('Супер теперь ты Админ', {reply_markup: {remove_keyboard: true}});
});

regFinished.hears('/help', async (ctx) => {
    ctx.replyWithMarkdown('/newtask - предложить задание\n');
});

async function newTask(ctx) {
    const {session} = ctx;

    session.task = {
        userChatId: session.user.chatId,
        userId: session.user.id,
        userMention: session.user.mention
    };

    await ctx.replyWithMarkdown('**Какое описание задания?**', {reply_markup: {remove_keyboard: true}});
    ctx.scene.enter('getTaskDescription');
}

adminScene.hears('/newtask', newTask);
regFinished.hears('/newtask', newTask);


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
    await ctx.replyWithMarkdown('Отлично твое задание на модерации', {reply_markup: {remove_keyboard: true}});
    
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
        `Описание - /setDescription${task.id} \n` +
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
        task.description} ${task.userMention
    }`).join('\n'), {reply_markup: {remove_keyboard: true}});
});

adminScene.hears('/users', async (ctx) => {
    const userList = await users.getAll();

    await ctx.replyWithMarkdown(userList.map(user => `${
        user.id} - ${user.mention}: ${ user.playing
    }`).join('\n'), {reply_markup: {remove_keyboard: true}});
});


adminScene.hears(new RegExp('/approve(\\d+)'), async (ctx) => {
    const {match} = ctx;
    const id = Number(match[1]);
    const task = await tasks.getItemById(id);

    task.approved = true;
    task.save();
    
    await ctx.telegram.sendMessage(task.userChatId, `Твое задание апрувнули: ${task.description}`);
    await ctx.replyWithMarkdown('DONE', {reply_markup: {remove_keyboard: true}});
});


adminScene.hears(new RegExp('/reject(\\d+)'), async (ctx) => {
    const {match} = ctx;
    const id = Number(match[1]);
    const task = await tasks.getItemById(id);

    task.approved = false;
    task.save();
    
    await ctx.telegram.sendMessage(task.userChatId, `Твое задание забанили: ${task.description}`);
    await ctx.replyWithMarkdown('DONE', {reply_markup: {remove_keyboard: true}});
});

adminScene.hears(new RegExp('/setDescription(\\d+) (.*)'), async (ctx) => {
    const {match} = ctx;
    const id = Number(match[1]);
    const description = match[2];
    const task = await tasks.getItemById(id);

    task.description = description;
    task.save();
    
    await ctx.replyWithMarkdown('DONE', {reply_markup: {remove_keyboard: true}});
});

adminScene.hears(new RegExp('/channel (.*)'), async (ctx) => {
    const {match} = ctx;
    const text = match[1];
    const chatId = await state.getChatId();
    const userInstances = await users.getAll();
    
    await ctx.telegram.sendMessage(chatId, `${userInstances.map(({mention}) => mention).join(' ')}\n\n${text}`, {parse_mode: 'Markdown'});
});

adminScene.hears(new RegExp('/setRating(\\d+) (\\d+)'), async (ctx) => {
    const {match} = ctx;
    const id = Number(match[1]);
    const rating = Number(match[2]);
    const task = await tasks.getItemById(id);

    task.rating = rating;
    task.save();
    
    await ctx.replyWithMarkdown('DONE', {reply_markup: {remove_keyboard: true}});
});

adminScene.hears(new RegExp('/setLevel(\\d+) (\\d+)'), async (ctx) => {
    const {match} = ctx;
    const id = Number(match[1]);
    const level = Number(match[2]);
    const task = await tasks.getItemById(id);

    task.level = level;
    task.save();
    
    await ctx.replyWithMarkdown('DONE', {reply_markup: {remove_keyboard: true}});
});

adminScene.hears(new RegExp(`/setPartner(\\d+) (${Object.values(BOOLEANS_WITH_ANY).join('|')})`), async (ctx) => {
    const {match} = ctx;
    const id = Number(match[1]);
    const withPartner = match[2];
    const task = await tasks.getItemById(id);

    task.withPartner = withPartner;
    task.save();
    
    await ctx.replyWithMarkdown('DONE', {reply_markup: {remove_keyboard: true}});
});

adminScene.hears(new RegExp(`/setSex(\\d+) (${Object.values(SEXES_WITH_ANY).join('|')})`), async (ctx) => {
    const {match} = ctx;
    const id = Number(match[1]);
    const sex = match[2];
    const task = await tasks.getItemById(id);

    task.sex = sex;
    task.save();
    
    await ctx.replyWithMarkdown('DONE', {reply_markup: {remove_keyboard: true}});
});


adminScene.hears(new RegExp(`/setChatType(\\d+) (${Object.values(CHAT_TYPES).join('|')})`), async (ctx) => {
    const {match} = ctx;
    const id = Number(match[1]);
    const chatType = match[2];
    const task = await tasks.getItemById(id);

    task.chatType = chatType;
    task.save();
    
    await ctx.replyWithMarkdown('DONE', {reply_markup: {remove_keyboard: true}});
});

adminScene.hears(new RegExp(`/setLightAlco(\\d+) (${Object.values(BOOLEANS_WITH_ANY).join('|')})`), async (ctx) => {
    const {match} = ctx;
    const id = Number(match[1]);
    const lightAlco = match[2];
    const task = await tasks.getItemById(id);

    task.lightAlco = lightAlco;
    task.save();
    
    await ctx.replyWithMarkdown('DONE', {reply_markup: {remove_keyboard: true}});
});

adminScene.hears(new RegExp(`/setMiddleAlco(\\d+) (${Object.values(BOOLEANS_WITH_ANY).join('|')})`), async (ctx) => {
    const {match} = ctx;
    const id = Number(match[1]);
    const middleAlco = match[2];
    const task = await tasks.getItemById(id);

    task.middleAlco = middleAlco;
    task.save();
    
    await ctx.replyWithMarkdown('DONE', {reply_markup: {remove_keyboard: true}});
});


adminScene.hears(new RegExp(`/setHardAlco(\\d+) (${Object.values(BOOLEANS_WITH_ANY).join('|')})`), async (ctx) => {
    const {match} = ctx;
    const id = Number(match[1]);
    const hardAlco = match[2];
    const task = await tasks.getItemById(id);

    task.hardAlco = hardAlco;
    task.save();
    
    await ctx.replyWithMarkdown('DONE', {reply_markup: {remove_keyboard: true}});
});

adminScene.hears('/resetTask', async (ctx) => {
    const currentTaskId = await state.getCurrentTaskId();
    const chatId = await state.getChatId();

    await state.updateCurrentTaskId(null);
    await state.updateCurrentUserId(null);
    await ctx.replyWithMarkdown(`Task ${currentTaskId} has been reseted`, {parse_mode: 'Markdown'});
    await ctx.telegram.sendMessage(chatId, `Текущее задание было отменено администратором`, {parse_mode: 'Markdown'});
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
        `Описание - /setDescription${task.id} \n` +
        `Пол - /setSex${task.id} \n` +
        `Приватный - /setChatType${task.id} \n` +
        `Можно с пивом - /setLightAlco${task.id} \n` +
        `Можно с вином - /setMiddleAlco${task.id} \n` +
        `Можно с водкой - /setHardAlco${task.id} \n`,
        {reply_markup: {remove_keyboard: true}}
    );
});

adminScene.hears(new RegExp('/user(\\d+)'), async (ctx) => {
    const {match} = ctx;
    const id = Number(match[1]);
    const user = await users.getItemById(id);

    await ctx.reply(`${JSON.stringify(user, null, 4)} ` +
        `Инфо - /user${user.id} \n` +
        `Блок юзера - /userblock${user.id} \n` +
        `АнБлок юзера - /userunblock${user.id} \n`,
        {reply_markup: {remove_keyboard: true}}
    );
});

adminScene.hears(new RegExp(`/userblock(\\d+)`), async (ctx) => {
    const {match} = ctx;
    const id = Number(match[1]);
    const user = await users.getItemById(id);

    user.playing = false;
    user.save();
    
    await ctx.replyWithMarkdown('DONE', {reply_markup: {remove_keyboard: true}});
});

adminScene.hears(new RegExp(`/userunblock(\\d+)`), async (ctx) => {
    const {match} = ctx;
    const id = Number(match[1]);
    const user = await users.getItemById(id);

    user.playing = true;
    user.save();
    
    await ctx.replyWithMarkdown('DONE', {reply_markup: {remove_keyboard: true}});
});

regFinished.on('text', async (ctx) => {
    ctx.replyWithMarkdown('Ты уже в игре, переходи в общий чат. Если хочешь перерегестрироваться, пиши /register', {reply_markup: {remove_keyboard: true}});
})

console.log('launched');
bot.startPolling();

async function findPidor() {
    const chatId = await state.getChatId();

    const suitableUsers = await users.filterItems({playing: true});
    const randomUser = suitableUsers[Math.round(Math.random() * (suitableUsers.length - 1))];
    
    await state.updatePidorDate(new Date());

    await bot.telegram.sendMessage(chatId, `Внимание внимание! Пидор этого часа - ${randomUser.mention}`, {parse_mode: 'Markdown'});
    await bot.telegram.sendMessage(chatId, `Напоминаю, что каждый имеет право называть этого человека пидором, в течение часа`, {parse_mode: 'Markdown'});
}

async function findPretty() {
    const chatId = await state.getChatId();

    const suitableUsers = await users.filterItems({playing: true});
    const randomUser = suitableUsers[Math.round(Math.random() * (suitableUsers.length - 1))];

    await state.updateAwesomeDate(new Date());

    await bot.telegram.sendMessage(chatId, `Внимание внимание! Красавчик этого часа - ${randomUser.mention}`, {parse_mode: 'Markdown'});
    await bot.telegram.sendMessage(chatId, `${randomUser.mention} в течение этого часа, ты должен быть в центре внимания!`, {parse_mode: 'Markdown'});
}

http.createServer((req, res) => {
    res.writeHead(200);
    res.end();
}).listen(process.env.PORT);
