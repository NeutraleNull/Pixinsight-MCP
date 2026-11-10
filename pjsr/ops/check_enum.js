// Runs only in the disposable shadow instance, because this assignment may hang or crash it.
const P = new globalThis[args.processId];
try
{
   P[args.param] = globalThis[args.processId][args.constant];
}
catch ( error )
{
   ctx.fail( "invalid_parameter_value", "" + (error.message || error) );
}
return { accepted: true };
