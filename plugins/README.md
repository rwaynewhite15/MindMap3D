# Installed plugins go here

This folder is where MindMapShare looks for add-ons, once, at startup. One
folder per plugin, each with a `plugin.json` inside it:

```
plugins/
  manufacturing/
    plugin.json
    server.js
    public/
      client.js
      client.css
```

It starts empty, and an empty folder is the normal state: with nothing here the
app is exactly what it is without the plugin system.

## Installing one

```bash
node tools/install-plugin.js manufacturing            # a package that ships with this repo
node tools/install-plugin.js ~/Downloads/plugin.zip   # one that was downloaded
node tools/install-plugin.js --list                   # what is installed
node tools/install-plugin.js --remove manufacturing   # take one back off
```

Then restart the server. Plugins are read once at startup, so a newly installed
one appears on the next start and not before.

Copying the folder in by hand works exactly as well — the installer only adds
the checks: that the package really is a plugin, that its manifest names files
it actually ships, and that a downloaded archive writes nothing outside the
folder it claims.

## What is in here is not committed

`plugins/*` is in `.gitignore` (this file is the exception). An installed plugin
is a local artifact, like `node_modules`: it came from a download, and it is
reinstalled rather than committed. On a hosted deployment, either add
`node tools/install-plugin.js <name>` to the build command or commit the folder
deliberately with `git add -f plugins/<id>`.

## A word on trust

A plugin's `server.js` is loaded into the server process and runs with
everything that process can reach — the database, the environment, the network.
Its client code runs on the page alongside the app. Install plugins you trust,
from where you meant to get them. Removing one is deleting its folder.

Accounts keep what a plugin saved even after it is removed: plugin data lives on
the user record in the database, not in this folder, and it comes back if the
plugin is installed again. It is included in **Export my data** either way.

## Writing one

See `plugin-packages/manufacturing/` for a complete example, and the "Plugins"
section of the main README for the manifest fields and the two hooks a plugin
implements.
