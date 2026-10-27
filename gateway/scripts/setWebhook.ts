const setWebHook = async () => {
  const res = await fetch(
    `https://api.telegram.org/bot8955725307:AAG7DvFAtFqAgJqPeqGY2EtXtqVbbV22ZOI/setWebhook`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: `https://dezhbanbot.ir/webhook/DHMuyh4AMwkIJEpTUOfUYvRe4hYnW8IZWy6cmi9aOj0MMTechCode`, // Telegram passes the token back in the path
        max_connections: 100,
        drop_pending_updates: false,
        allowed_updates: [
          "message",
          "edited_message",
          "callback_query",
          "my_chat_member",
          "message_reaction",
        ],
      }),
    },
  );
  console.log(await res.json());
};

setWebHook();
