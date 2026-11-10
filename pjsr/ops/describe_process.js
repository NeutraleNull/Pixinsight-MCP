// Everything here comes from the running PixInsight, so it covers third-party modules and
// follows updates without any hand-written tables.
const id = args.processId;
const { meta, instance: P } = ctx.process( id );

// The default instance prints enumerated values by name: P.mode = StarAlignment.RegisterMatch;
const enumDefaults = new Map();
for ( const line of P.toSource( "JavaScript", "P", 0, 0 ).split( "\n" ) )
{
   const match = /^P\.(\w+) = (\w+)\.(\w+);$/.exec( line );
   if ( match && match[2] == id )
      enumDefaults.set( match[1], match[3] );
}

const tables = new Set( meta.properties.filter( p => p.description.startsWith( "Array " ) ).map( p => p.id ) );
const columns = new Map();
const constants = [];
for ( const c of meta.constants )
{
   // <table>_<column> constants are column indices, not values anyone should assign.
   const separator = c.id.indexOf( "_" );
   const table = (separator > 0) ? c.id.substring( 0, separator ) : "";
   const match = /= (-?\d+)\s*$/.exec( c.description );
   const value = match ? Number( match[1] ) : null;
   if ( tables.has( table ) )
   {
      if ( !columns.has( table ) )
         columns.set( table, [] );
      columns.get( table ).push( { name: c.id.substring( separator + 1 ), index: value } );
      continue;
   }
   if ( match )
      constants.push( { name: c.id, value } );
}
constants.sort( ( a, b ) => a.value - b.value || a.name.localeCompare( b.name ) );

const parameters = meta.properties.map( p =>
{
   const type = ctx.parameterType( p );
   const parameter = { id: p.id, type, readOnly: p.readOnly };
   if ( ctx.isEnumeration( p ) )
      parameter.enum = true;
   // The metadata lists columns alphabetically. The value of each constant is its real position.
   if ( columns.has( p.id ) )
      parameter.columns = columns.get( p.id ).sort( ( a, b ) => a.index - b.index ).map( c => c.name );
   if ( !p.readOnly )
      parameter.default = enumDefaults.has( p.id ) ? enumDefaults.get( p.id ) : P[p.id];
   return parameter;
} );

return {
   id,
   categories: ctx.categories( P ),
   canProcessViews: P.canProcessViews(),
   canProcessGlobal: P.canProcessGlobal(),
   parameters,
   constants
};
