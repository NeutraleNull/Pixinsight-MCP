return MetaObject.externalObjects.map( id =>
{
   const { meta, instance: P } = ctx.process( id );
   return {
      id,
      categories: ctx.categories( P ),
      canProcessViews: P.canProcessViews(),
      canProcessGlobal: P.canProcessGlobal(),
      parameters: meta.properties.filter( p => !p.readOnly ).length
   };
} );
