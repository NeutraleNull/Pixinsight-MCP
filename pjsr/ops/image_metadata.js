// What a file says about how it was taken: its FITS keywords, and the properties with a simple
// value. Lines of text that programs leave in a file are only counted, unless they are asked for.
const view = ctx.view( args.view );
const window = view.window;
const wanted = args.search ? String( args.search ).toLowerCase() : null;
const MAX_ENTRIES = 300;
const MAX_TEXT = 300;

const matches = name => wanted === null || name.toLowerCase().includes( wanted );
const clip = text => text.length > MAX_TEXT ? text.substring( 0, MAX_TEXT - 1 ) + "…" : text;

const keywords = [];
let moreKeywords = 0, textLines = 0;
for ( const keyword of window.keywords )
{
   const name = keyword.name;
   if ( wanted === null && (name == "HISTORY" || name == "COMMENT") )
   {
      ++textLines;
      continue;
   }
   if ( !matches( name ) )
      continue;
   if ( keywords.length >= MAX_ENTRIES )
   {
      ++moreKeywords;
      continue;
   }
   const entry = { name: name };
   // A value in quotes is a text, whatever it looks like.
   const quoted = keyword.value.trim().startsWith( "'" );
   if ( !quoted && keyword.isNumeric )
      entry.value = keyword.numericValue;
   else if ( !quoted && keyword.isBoolean )
      entry.value = keyword.strippedValue.toUpperCase() == "T";
   else
      entry.value = clip( keyword.strippedValue );
   if ( keyword.comment )
      entry.comment = clip( keyword.comment );
   keywords.push( entry );
}

// A property can hold a whole table, such as the solution of the astrometry. Only what says
// something in one line is returned.
const properties = [];
let otherProperties = 0, moreProperties = 0;
for ( const id of window.mainView.properties )
{
   if ( !matches( id ) )
      continue;
   let value;
   try
   {
      value = window.mainView.propertyValue( id );
   }
   catch ( error )
   {
      value = undefined;
   }
   // A point in time, such as the start of an exposure, reads best as a text.
   if ( value instanceof Date && isFinite( value.getTime() ) )
      value = value.toISOString();
   const simple = typeof value == "boolean" || typeof value == "string" || (typeof value == "number" && isFinite( value ));
   if ( !simple )
      ++otherProperties;
   else if ( properties.length >= MAX_ENTRIES )
      ++moreProperties;
   else
      properties.push( { id: id, value: typeof value == "string" ? clip( value ) : value } );
}

const result = { view: window.mainView.id, keywords: keywords, properties: properties };
if ( moreKeywords > 0 )
   result.moreKeywords = moreKeywords;
if ( textLines > 0 )
   result.textLines = textLines;
if ( otherProperties > 0 )
   result.otherProperties = otherProperties;
if ( moreProperties > 0 )
   result.moreProperties = moreProperties;
return result;
