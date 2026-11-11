<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
  <xsl:output method="html" encoding="UTF-8" indent="yes" />
  <xsl:template match="/">
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title><xsl:value-of select="portal/meta/title" /></title>
        <style>
          :root {
            --bg-color: #0f172a;
            --card-bg: #1e293b;
            --card-hover: #334155;
            --text-primary: #f8fafc;
            --text-secondary: #94a3b8;
            --accent: #38bdf8;
            --accent-gradient: linear-gradient(135deg, #38bdf8 0%, #818cf8 100%);
            --tag-bg: #0369a1;
            --tag-text: #e0f2fe;
            --border: #334155;
          }

          * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
          }

          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background-color: var(--bg-color);
            color: var(--text-primary);
            line-height: 1.6;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
          }

          header {
            background: linear-gradient(180deg, rgba(30, 41, 59, 0.8) 0%, rgba(15, 23, 42, 0) 100%);
            padding: 3.5rem 1.5rem 2rem;
            text-align: center;
          }

          .header-container {
            max-width: 900px;
            margin: 0 auto;
          }

          h1 {
            font-size: 2.75rem;
            font-weight: 800;
            background: var(--accent-gradient);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 0.75rem;
          }

          .subtitle {
            font-size: 1.15rem;
            color: var(--text-secondary);
            max-width: 650px;
            margin: 0 auto 1.5rem;
          }

          .repo-links {
            display: flex;
            justify-content: center;
            gap: 1rem;
            flex-wrap: wrap;
          }

          .btn {
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.6rem 1.25rem;
            border-radius: 9999px;
            font-size: 0.9rem;
            font-weight: 600;
            text-decoration: none;
            transition: all 0.2s ease;
          }

          .btn-primary {
            background: var(--accent-gradient);
            color: #0f172a;
          }

          .btn-primary:hover {
            opacity: 0.9;
            transform: translateY(-1px);
          }

          .btn-secondary {
            background: var(--card-bg);
            color: var(--text-primary);
            border: 1px solid var(--border);
          }

          .btn-secondary:hover {
            background: var(--card-hover);
          }

          main {
            flex: 1;
            max-width: 1000px;
            margin: 0 auto;
            padding: 1.5rem;
            width: 100%;
          }

          .grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
            gap: 1.5rem;
          }

          .card {
            background-color: var(--card-bg);
            border: 1px solid var(--border);
            border-radius: 1rem;
            padding: 1.5rem;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
          }

          .card:hover {
            transform: translateY(-4px);
            border-color: #38bdf8;
            box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3), 0 8px 10px -6px rgba(0, 0, 0, 0.3);
          }

          .card-header {
            margin-bottom: 1rem;
          }

          .badge {
            display: inline-block;
            font-size: 0.75rem;
            text-transform: uppercase;
            font-weight: 700;
            letter-spacing: 0.05em;
            background-color: var(--tag-bg);
            color: var(--tag-text);
            padding: 0.2rem 0.6rem;
            border-radius: 9999px;
            margin-bottom: 0.75rem;
          }

          .card-title {
            font-size: 1.35rem;
            font-weight: 700;
            color: var(--text-primary);
            margin-bottom: 0.5rem;
          }

          .card-tech {
            font-size: 0.8rem;
            color: var(--accent);
            font-family: monospace;
            margin-bottom: 0.75rem;
          }

          .card-desc {
            font-size: 0.95rem;
            color: var(--text-secondary);
            margin-bottom: 1.5rem;
            line-height: 1.5;
          }

          .card-action {
            display: inline-block;
            width: 100%;
            text-align: center;
            background: #2563eb;
            color: white;
            padding: 0.65rem 1rem;
            border-radius: 0.5rem;
            font-weight: 600;
            text-decoration: none;
            transition: background 0.2s ease;
          }

          .card-action:hover {
            background: #1d4ed8;
          }

          footer {
            border-top: 1px solid var(--border);
            text-align: center;
            padding: 2rem 1.5rem;
            font-size: 0.875rem;
            color: var(--text-secondary);
            margin-top: 3rem;
          }

          footer a {
            color: var(--accent);
            text-decoration: none;
          }

          footer a:hover {
            text-decoration: underline;
          }
        </style>
      </head>
      <body>
        <header>
          <div class="header-container">
            <h1><xsl:value-of select="portal/meta/title" /></h1>
            <p class="subtitle"><xsl:value-of select="portal/meta/description" /></p>
            <div class="repo-links">
              <a class="btn btn-secondary">
                <xsl:attribute name="href">
                  <xsl:value-of select="portal/meta/repository" />
                </xsl:attribute>
                GitHub Repository
              </a>
              <a class="btn btn-secondary" href="index.xml">
                Raw XML Feed
              </a>
            </div>
          </div>
        </header>

        <main>
          <div class="grid">
            <xsl:for-each select="portal/apps/app">
              <div class="card">
                <div>
                  <div class="card-header">
                    <span class="badge"><xsl:value-of select="category" /></span>
                    <h2 class="card-title"><xsl:value-of select="name" /></h2>
                    <div class="card-tech"><xsl:value-of select="technology" /></div>
                  </div>
                  <p class="card-desc"><xsl:value-of select="description" /></p>
                </div>
                <div>
                  <a class="card-action">
                    <xsl:attribute name="href">
                      <xsl:value-of select="url" />
                    </xsl:attribute>
                    Launch App &#8594;
                  </a>
                </div>
              </div>
            </xsl:for-each>
          </div>
        </main>

        <footer>
          <p>
            Hosted on GitHub Pages &#8226; Main XML Index:
            <a>
              <xsl:attribute name="href">
                <xsl:value-of select="portal/meta/baseUrl" />index.xml
              </xsl:attribute>
              <xsl:value-of select="portal/meta/baseUrl" />index.xml
            </a>
          </p>
        </footer>
      </body>
    </html>
  </xsl:template>
</xsl:stylesheet>
