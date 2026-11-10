// Runs when the script that was sent ahead of this job has ended: PixInsight takes one script
// after the other. A script returns nothing, so the report is what is different now.
const report = ctx.changesSince( args.before );
report.script = args.script;
report.startedOn = args.startedOn;
report.activeAfter = ctx.activeView();
return report;
