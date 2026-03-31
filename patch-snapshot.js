const fs = require('fs');
let code = fs.readFileSync('apps/cli/test/kernel-import.test.ts', 'utf8');

code = code.replace(
  '"createEventBus",\n\t\t\t\t"parseUnitPacket",\n\t\t\t\t"validatePacketForWorkspaceRoot",',
  '"createEventBus",\n\t\t\t\t"createGraphScheduler",\n\t\t\t\t"createResourceUsageSnapshot",\n\t\t\t\t"parseUnitPacket",\n\t\t\t\t"validatePacketForWorkspaceRoot",'
);

fs.writeFileSync('apps/cli/test/kernel-import.test.ts', code);
