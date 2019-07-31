export async function sendMessageToUsers(users, message, ctx) {

    for (let user of users) {
        await ctx.telegram.sendMessage(user.chatId, message);
    }
}