const fs = require('fs');
const path = require('path');

const modelsDir = path.join(__dirname, 'src/models');
const files = fs.readdirSync(modelsDir).filter(f => f.endsWith('.js'));

const inventory = {};

for (const file of files) {
  try {
    const model = require(path.join(modelsDir, file));
    const schema = model.schema;
    if (schema) {
      inventory[model.modelName] = {};
      for (const [pathName, schemaType] of Object.entries(schema.paths)) {
        inventory[model.modelName][pathName] = {
          type: schemaType.instance,
          required: !!schemaType.isRequired,
          default: schemaType.options.default,
          enum: schemaType.options.enum,
          ref: schemaType.options.ref
        };
      }
    }
  } catch (err) {
    console.error(`Failed to load ${file}:`, err.message);
  }
}

fs.writeFileSync(path.join(__dirname, 'inventory.json'), JSON.stringify(inventory, null, 2));
console.log('Inventory saved to inventory.json');
