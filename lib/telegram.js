// lib/telegram.js
//
// সব জায়গায় (checkJoin, taskComplete, withdraw notification, admin bot)
// বারবার একই fetch কোড না লিখে এই helper গুলো শেয়ার করা হচ্ছে।

const BOT_TOKEN = process.env.BOT_TOKEN;

export async function tgApi(method, body) {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return res.json();
}

export const tgSend = (chatId, text, extra = {}) =>
    tgApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });

export const tgEdit = (chatId, messageId, text, extra = {}) =>
    tgApi('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...extra });

// ⚠️ NEW — Telegram rejects editMessageText on a message that was sent as a
// photo (sendPhoto) with "Bad Request: there is no text in the message to
// edit". Photo messages only have a CAPTION, so they need editMessageCaption
// instead. tgApi() doesn't throw on a Telegram-side {ok:false} error (only
// on a network failure), so calling tgEdit on a photo message fails
// completely silently — the caller sees no exception, the message just
// never changes. Use this whenever the message being edited was sent via
// tgSendPhoto (see the bc_confirm handler in api/bot.js for the bug this fixed).
export const tgEditCaption = (chatId, messageId, caption, extra = {}) =>
    tgApi('editMessageCaption', { chat_id: chatId, message_id: messageId, caption, parse_mode: 'HTML', ...extra });

export const tgSendPhoto = (chatId, photo, caption, extra = {}) =>
    tgApi('sendPhoto', { chat_id: chatId, photo, caption, parse_mode: 'HTML', ...extra });

export const tgAnswerCallback = (callbackQueryId, text = '', showAlert = false) =>
    tgApi('answerCallbackQuery', { callback_query_id: callbackQueryId, text, show_alert: showAlert });

// userId-কে CHANNEL/GROUP-এ মেম্বার কিনা চেক করে
export async function isMember(userId, chatUsername) {
    try {
        const r = await tgApi('getChatMember', { chat_id: chatUsername, user_id: userId });
        if (!r.ok) {
            // Telegram-এর আসল error message log করছি — bot admin থাকলেও fail হলে এখানেই কারণ দেখা যাবে
            // (যেমন: bot ওই chat-এ নেই, username ভুল, ইত্যাদি)
            console.error(`isMember(${userId}, ${chatUsername}) failed:`, r.description);
            return false;
        }
        return ['member', 'administrator', 'creator'].includes(r.result?.status);
    } catch (err) {
        console.error(`isMember(${userId}, ${chatUsername}) threw:`, err.message);
        return false; // Telegram API fail করলে ধরে নিন member না — fail-safe
    }
}

// আপনার main.html-এ পাওয়া official channel/community
export const OFFICIAL_CHANNEL = '@Newtube_offcial'; // ⚠️ SEASON 3 CHANGE — new official channel, https://t.me/Newtube_offcial
export const COMMUNITY_GROUP = '@newtube_commonity';
// ⚠️ FIX — this was pointing at the OLD shared "fruit_cut_payment" channel.
// The post-on-approve code below (api/bot.js wd_approve_) was working fine —
// the bot IS an admin of that old channel too, so it posted successfully
// every time, just to the wrong (old/shared) channel, which is why nothing
// ever showed up in the new https://t.me/Newtube_pay_chennel channel and it
// looked like posting had silently stopped. Now pointed at the real one.
export const PAYMENT_CHANNEL = '@Newtube_pay_chennel'; // https://t.me/Newtube_pay_chennel
// ⚠️ NEW — fixed proof-of-payment banner posted with every approved withdrawal
// (see api/bot.js wd_approve_). Swap this URL if you want a different image later.
export const PAYMENT_PROOF_PHOTO = 'https://cdn.phototourl.com/free/2026-08-07-562ff309-be9d-4683-974d-e5a27da44e18.png';
