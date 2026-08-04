const path = require("path")

const ROOT = path.resolve(__dirname)

module.exports = {
  skillsDir: path.join(ROOT, "skills"),
  agentsDir: path.join(ROOT, "agents"),
  scriptsDir: path.join(ROOT, "scripts"),
  templatesDir: path.join(ROOT, "templates"),
  presetsDir: path.join(ROOT, "presets"),
  configDir: path.join(ROOT, "config"),
  rulesDir: path.join(ROOT, "rules"),
  commandsDir: path.join(ROOT, "commands"),
}