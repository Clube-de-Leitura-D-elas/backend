import "jsr:@supabase/functions-js/edge-runtime.d.ts"

Deno.serve(async (req) => {
  const html = `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>E-mail Confirmado</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
          background-color: #F8E8E5; /* Cor suave inspirada no design system */
          display: flex;
          justify-content: center;
          align-items: center;
          height: 100vh;
          margin: 0;
          color: #4A2E2A;
        }
        .container {
          background: #FFFFFF;
          padding: 40px;
          border-radius: 12px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.05);
          text-align: center;
          max-width: 400px;
          width: 90%;
        }
        h1 {
          color: #E26959; /* Cor principal (Primary) */
          margin-bottom: 16px;
        }
        p {
          font-size: 16px;
          line-height: 1.5;
          margin-bottom: 24px;
        }
        .icon {
          font-size: 64px;
          margin-bottom: 16px;
        }
        .btn {
          display: inline-block;
          background-color: #E26959;
          color: white;
          text-decoration: none;
          padding: 12px 24px;
          border-radius: 8px;
          font-weight: 600;
          transition: opacity 0.2s;
        }
        .btn:hover {
          opacity: 0.9;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="icon">✅</div>
        <h1>E-mail Confirmado!</h1>
        <p>Sua conta no Clube de Leitura D'Elas foi ativada com sucesso. Você já pode retornar ao aplicativo para fazer login e continuar.</p>
        <!-- Tenta voltar ao app (Deep link) caso o usuário esteja no celular -->
        <a href="clube-de-leitura://login" class="btn">Retornar ao App</a>
      </div>
    </body>
    </html>
  `

  return new Response(html, {
    headers: { "Content-Type": "text/html" },
  })
})
