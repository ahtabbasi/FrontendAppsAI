# FrontendAppsAI

> Multi-application repository hosting standalone frontend-only web applications on GitHub Pages. Each app lives in its own subdirectory and is served on a dedicated sub-URL.

🔗 **Live Portal URL (Main XML Index):** [https://ahtabbasi.github.io/FrontendAppsAI/index.xml](https://ahtabbasi.github.io/FrontendAppsAI/index.xml)
🌐 **Live GitHub Pages URL:** [https://ahtabbasi.github.io/FrontendAppsAI/](https://ahtabbasi.github.io/FrontendAppsAI/)

---

## 📖 Overview & Architecture

This repository is designed as a centralized hub for multiple frontend-only web applications. Every application is:
- **Frontend-only:** No server-side runtime requirements (runs purely in the client browser using static assets: HTML, CSS, JavaScript, WASM, static builds of React/Vue/Svelte, etc.).
- **Self-contained in its own directory:** Each application resides in its own folder (e.g., `demo-app/`, `counter-app/`).
- **Served on a dedicated sub-URL:** Hosted at `https://ahtabbasi.github.io/FrontendAppsAI/<app-folder>/`.
- **Linked via a central XML index:** The main index is defined in `index.xml`, paired with an XSL stylesheet (`style.xsl`) so it renders cleanly and interactively in web browsers while functioning as a structured machine-readable catalog.

---

## 🚀 Live Applications

| Application | Category | Technology | Path / Sub-URL | Live Link |
| :--- | :--- | :--- | :--- | :--- |
| **Demo App** | Showcase | Vanilla HTML5 / CSS / ES6 | `demo-app/` | [Launch App](https://ahtabbasi.github.io/FrontendAppsAI/demo-app/) |
| **Counter App** | Utility | Vanilla HTML5 / CSS3 / JS | `counter-app/` | [Launch App](https://ahtabbasi.github.io/FrontendAppsAI/counter-app/) |

---

## ⚙️ Repository & GitHub Pages Configuration Instructions

To ensure GitHub Pages serves this repository and the repository metadata displays the correct link and description, follow these settings in GitHub:

### 1. Enable GitHub Pages
1. Go to repository **Settings** on GitHub: `https://github.com/ahtabbasi/FrontendAppsAI/settings`
2. In the left sidebar, click on **Pages** (under "Code and automation").
3. Under **Build and deployment** > **Source**:
   - Select **GitHub Actions** (recommended, as `.github/workflows/deploy.yml` is included in this repository).
   - *Alternatively*, you can select **Deploy from a branch** and choose `main` with `/ (root)` folder.
4. Once deployed, the site will be available at:
   - `https://ahtabbasi.github.io/FrontendAppsAI/index.xml`
   - `https://ahtabbasi.github.io/FrontendAppsAI/`

### 2. Update Repository Description and Website URL
1. Navigate to the main code page: `https://github.com/ahtabbasi/FrontendAppsAI`
2. At the top right of the repository landing page, click the **⚙️ (Edit repository details)** button next to the "About" section.
3. Update the fields as follows:
   - **Description:**
     ```
     Multi-application frontend repository hosted on GitHub Pages: https://ahtabbasi.github.io/FrontendAppsAI/index.xml
     ```
   - **Website:**
     ```
     https://ahtabbasi.github.io/FrontendAppsAI/index.xml
     ```
   - **Include in the home page:** Ensure "Use your GitHub Pages website" or custom URL is selected.
4. Click **Save changes**.

---

## ➕ Adding a New Frontend App

To add a new frontend app to this repository:

1. **Create a new folder** in the repository root for your application:
   ```bash
   mkdir my-new-app
   ```
2. **Add your frontend assets** into `my-new-app/` (at minimum an `index.html` file).
   - If using a framework (React, Vue, Vite, etc.), ensure relative base path is set (e.g., `base: './'` in Vite or `<base href="/FrontendAppsAI/my-new-app/">`) so all asset paths resolve properly on GitHub Pages.
3. **Register the app in `index.xml`**:
   Add a new `<app>` block inside the `<apps>` element in `index.xml`:
   ```xml
   <app id="my-new-app">
     <name>My New App</name>
     <category>Category Name</category>
     <technology>Technology Stack</technology>
     <path>my-new-app/</path>
     <url>my-new-app/index.html</url>
     <description>Brief description of what this frontend app does.</description>
   </app>
   ```
4. **Update the table in `README.md`** to include your new app.
5. **Commit and push** to the `main` branch. GitHub Actions will deploy the update automatically.

---

## 💻 Local Development & Preview

You can preview the entire portal and all sub-apps locally using any static web server:

```bash
# Using Python
python3 -m http.server 8000

# Open in browser:
# http://localhost:8000/index.xml
# http://localhost:8000/demo-app/
# http://localhost:8000/counter-app/
```
