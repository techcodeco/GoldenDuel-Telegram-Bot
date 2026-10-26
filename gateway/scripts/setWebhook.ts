const setWebHook = async () => {
  const res = await fetch(
    `https://api.telegram.org/bot8710819629:AAGjPOM6HOIneAwlMHO3rC9EMujRCo14FLg/setWebhook`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: `https://dezhbanbot.ir/webhook/114c88c14ba9151890dc0fe9f3c72e00a515edec3f44a60b`, // Telegram passes the token back in the path
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
