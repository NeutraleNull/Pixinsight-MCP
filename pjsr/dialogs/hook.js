// Lets the server read and work the dialogs of a script that it starts for the user.
//
// This is not a script of its own. The server writes a file into the folder of the job that calls
// this function and then includes the script, so both share one scope. It has to run on both
// engines of PixInsight, which is why it is written in the JavaScript of the older one, and it
// changes as little of PixInsight's objects as it can:
//
// - The older engine keeps its scope from one script to the next, and does not survive a replaced
//   constructor. So only methods are replaced there: the two that run a dialog and a message box,
//   and the three that lay out a control, through which the fields of a dialog are found. All
//   are put back: by the script the server sends right after, and by the methods themselves once
//   nobody waits for the job.
// - V8 starts every script in a fresh scope, but a dialog there has its methods on itself, where
//   they cannot be replaced. So the constructors are wrapped instead, those of the fields too.
//
// A dialog is served by a timer of its own, which runs while the dialog is open: read from the
// folder of the job what the server asks, do it, write the answer.
//
// The server says which engine this is, because it chose it with the file that calls this. What
// the scope looks like says nothing: on the older engine, a script before this one can have left
// anything in it.
function( jobDir, operate, v8 )
{
   var root = v8 ? globalThis : this;

   var MAX_SILENCE_MS = 15000;
   var TICK_SECONDS = 0.1;
   var MAX_FIELDS = 250;
   var MAX_TEXT = 300;
   var MAX_OPTIONS = 60;
   var MAX_ROWS = 60;
   var MAX_COLUMNS = 16;
   // For a field that is read by itself, and for a dialog that is mostly one text.
   var MAX_DETAIL_ROWS = 200;
   var MAX_DETAIL_COLUMNS = 40;
   var MAX_DETAIL_TEXT = 20000;
   var MAX_OVERVIEW_TEXT = 6000;
   var MAX_MADE = 20000;
   var MAX_SEEN = 2000;
   var MAX_DEPTH = 4;
   var MAX_SAMPLES = 9000;
   // What PixInsight's own constants for the buttons of a message box stand for, by their value.
   var BUTTONS = [ null, "ok", "cancel", "yes", "no", "abort", "retry", "ignore", "yes to all", "no to all" ];
   var ICONS = [ null, "question", "information", "warning", "error" ];
   var LEFT_BUTTON = 1;
   var COVER = 0xff808080;

   var NativeDialog = Dialog;
   var nativeExecute = null;
   var open = [];      // the dialogs of the script that are open, in the order they were opened
   var named = [];     // every dialog that was open, by the number in its name
   var shows = [];     // how often each of them was opened
   var slots = [];     // what the number in the name of a field stands for: the controls that took turns in one place
   var made = [];      // the fields the script has made, on V8, or laid out, on the older engine, wherever it keeps them
   var secrets = [];   // fields that hid what is typed at some point, and stay secret
   var timers = [];
   var question = null;
   var questions = 0;
   var stateSerial = 0;
   var lastState = null;
   var lastBeat = Date.now();
   var withdrawn = false;
   var lookedAt = 0;

   function refuse( kind, message )
   {
      var error = new Error( message );
      error.kind = kind;
      throw error;
   }

   // The older engine writes a warning to the console for every read of a property that is not
   // there, so nothing in this file reads one without asking first.
   function owns( object, name )
   {
      return Object.prototype.hasOwnProperty.call( object, name );
   }

   function kindIn( error )
   {
      return typeof error === "object" && error !== null && "kind" in error ? error.kind : null;
   }

   function textIn( error )
   {
      return typeof error === "object" && error !== null && "message" in error ? String( error.message ) : String( error );
   }

   function put( name, value )
   {
      var path = jobDir + "/" + name;
      File.writeTextFile( path + ".tmp", JSON.stringify( value ) );
      File.move( path + ".tmp", path );
   }

   // The server writes the time into this file while it waits for the job, and 0 once it has given
   // up. One read that fails proves nothing: the file is replaced once a second.
   function awaited()
   {
      var now = Date.now();
      if ( now - lookedAt >= 500 )
      {
         lookedAt = now;
         for ( var attempt = 0; attempt < 5; attempt++ )
         {
            try
            {
               var beat = Number( File.readTextFile( jobDir + "/awaited" ) );
               if ( beat === 0 )
                  withdrawn = true;
               else if ( beat > lastBeat )
                  lastBeat = beat;
               break;
            }
            catch ( error )
            {
               msleep( 15 );
            }
         }
      }
      return !withdrawn && now - lastBeat < MAX_SILENCE_MS;
   }

   function clip( text, max )
   {
      var all = String( text );
      return all.length > max ? all.substring( 0, max - 1 ) + "…" : all;
   }

   // For a text that PixInsight shows as it is: nothing in it is markup.
   function line( text, max )
   {
      return clip( String( text ).replace( /\s+/g, " " ).replace( /^ | $/g, "" ), max );
   }

   // For a text with markup, as labels with rich text, tooltips and message boxes have it.
   function plain( text, max )
   {
      return line( String( text ).replace( /<br\s*\/?>|<\/p>/gi, " " ).replace( /<[^>]*>/g, "" )
         .replace( /&nbsp;/g, " " ).replace( /&lt;/g, "<" ).replace( /&gt;/g, ">" ).replace( /&quot;/g, "\"" ).replace( /&amp;/g, "&" ), max );
   }

   // What was done on behalf of the user, for the user to read in the console. Nothing in such a
   // line may be taken for markup of the console, or start a line of its own: part of it is text
   // that the assistant chose.
   function note( text )
   {
      try
      {
         console.writeln( "MCP: " + String( text ).replace( /[\x00-\x1f\x7f]/g, " " ).replace( /</g, "‹" ).replace( />/g, "›" ) );
      }
      catch ( error )
      {
      }
   }

   // ------------------------------------------------------------------------------------------
   // What is open
   // ------------------------------------------------------------------------------------------

   function numberOf( dialog )
   {
      var index = named.indexOf( dialog );
      if ( index < 0 )
      {
         index = named.push( dialog ) - 1;
         shows.push( 0 );
      }
      return index;
   }

   function noteOpen( dialog )
   {
      if ( open.indexOf( dialog ) >= 0 )
         return;
      open.push( dialog );
      shows[numberOf( dialog )]++;
   }

   function noteClosed( dialog )
   {
      var at = open.indexOf( dialog );
      if ( at >= 0 )
         open.splice( at, 1 );
   }

   // The dialog that was opened last, which is the one a user could work.
   function topDialog()
   {
      for ( var i = open.length; --i >= 0; )
         if ( open[i].visible === true )
            return open[i];
      return null;
   }

   // Names one showing of a dialog. A dialog that is closed and opened again gets a new name, so
   // that nothing meant for what it showed before is done to what it shows now.
   function nameOf( dialog )
   {
      var index = numberOf( dialog );
      return "d" + ( index + 1 ) + "." + shows[index];
   }

   // The server learns from this file that a dialog has come or gone, or that the script asks
   // something. Every state gets a file of its own, so that a reader never finds half of one.
   function noteState()
   {
      var top = topDialog();
      var state = { dialog: top ? nameOf( top ) : null, title: top ? line( top.windowTitle, MAX_TEXT ) : null, question: question };
      var text = JSON.stringify( state );
      if ( text === lastState )
         return;
      state.serial = stateSerial + 1;
      try
      {
         put( "dialog-state-" + state.serial + ".json", state );
      }
      catch ( error )
      {
         // Not written, so it is tried again with the next tick.
         return;
      }
      lastState = text;
      stateSerial = state.serial;
      try
      {
         if ( stateSerial > 1 )
            File.remove( jobDir + "/dialog-state-" + ( stateSerial - 1 ) + ".json" );
      }
      catch ( error )
      {
      }
   }

   // ------------------------------------------------------------------------------------------
   // Reading a dialog
   // ------------------------------------------------------------------------------------------

   var KINDS = [ "NumericControl", "NumericEdit", "ViewList", "PushButton", "ToolButton", "CheckBox", "RadioButton", "ComboBox", "SpinBox",
      "Slider", "Edit", "TextBox", "Label", "TreeBox", "GroupBox", "TabBox" ];
   // Controls that are made of others, which are not worth a line of their own.
   var COMPOSITES = [ "NumericControl", "NumericEdit", "ViewList", "ComboBox", "SpinBox", "TreeBox" ];
   var classes = null;

   // A script of the older engine gets some of these from files it includes, so they are looked
   // up when needed, by name, in the scope of the script.
   function lookUpClasses()
   {
      classes = {};
      for ( var i = 0; i < KINDS.length; i++ )
      {
         var found;
         try
         {
            found = eval( KINDS[i] );
         }
         catch ( error )
         {
            found = undefined;
         }
         if ( typeof found === "function" )
            classes[KINDS[i]] = found;
      }
   }

   function isControl( value )
   {
      return value !== null && typeof value === "object" && value instanceof Control;
   }

   function kindOf( control )
   {
      for ( var i = 0; i < KINDS.length; i++ )
         if ( owns( classes, KINDS[i] ) && control instanceof classes[KINDS[i]] )
            return KINDS[i];
      return "Control";
   }

   function has( control, handler )
   {
      try
      {
         return typeof control[handler] === "function";
      }
      catch ( error )
      {
         return false;
      }
   }

   function rectOf( dialog, control )
   {
      var p = control.localToGlobal( new Point( 0, 0 ) );
      var d = dialog.localToGlobal( new Point( 0, 0 ) );
      return [ p.x - d.x, p.y - d.y, control.width, control.height ];
   }

   // The control under a point of the dialog that has no control inside it at that point.
   function deepest( dialog, x, y )
   {
      var control = dialog.childByPos( x, y );
      if ( !isControl( control ) || control === dialog )
         return null;
      for ( var depth = 0; depth < 12; depth++ )
      {
         var rect = rectOf( dialog, control );
         var inner = control.childByPos( x - rect[0], y - rect[1] );
         if ( !isControl( inner ) || inner === control )
            break;
         control = inner;
      }
      return control;
   }

   // A part of a control that is described as a whole stands for that control.
   function whole( dialog, control )
   {
      var result = control;
      var parent = control;
      for ( var depth = 0; depth < 20; depth++ )
      {
         try
         {
            parent = parent.parent;
         }
         catch ( error )
         {
            break;
         }
         if ( !isControl( parent ) || parent === dialog )
            break;
         if ( COMPOSITES.indexOf( kindOf( parent ) ) >= 0 )
            result = parent;
      }
      return result;
   }

   var baseNames = null;

   function ownerOf( control )
   {
      try
      {
         return control.dialog;
      }
      catch ( error )
      {
         return null;
      }
   }

   // On the older engine, what the script keeps: on the dialog, and on the objects and lists that
   // hang from it, a few steps deep. Only objects of the script are looked into, never one of
   // PixInsight, and never another dialog.
   function gather( dialog, value, depth, seen, add )
   {
      if ( value === null || typeof value !== "object" || seen.length >= MAX_SEEN || seen.indexOf( value ) >= 0 )
         return;
      seen.push( value );
      var list = value instanceof Array;
      if ( isControl( value ) )
      {
         if ( value !== dialog && ( value instanceof NativeDialog || ownerOf( value ) !== dialog ) )
            return;
         add( value );
      }
      else if ( !list && Object.prototype.toString.call( value ) !== "[object Object]" )
         return;
      if ( depth >= MAX_DEPTH )
         return;
      if ( list )
      {
         // A hole in a list is no element: reading one makes the older engine warn.
         for ( var a = 0; a < value.length && a < 300; a++ )
            if ( a in value )
               gather( dialog, value[a], depth + 1, seen, add );
         return;
      }
      var names = Object.getOwnPropertyNames( value );
      for ( var n = 0; n < names.length; n++ )
      {
         var inner;
         try
         {
            inner = value[names[n]];
         }
         catch ( error )
         {
            continue;
         }
         gather( dialog, inner, depth + 1, seen, add );
      }
   }

   // Several ways to the controls of a dialog, because none finds all. What the script keeps. What
   // the script was seen to make, on V8, or to lay out, on the older engine. And on V8 what lies
   // on the surface, whatever the script calls it. The surface alone misses a table or a text
   // box: PixInsight has no object for the parts such a field is made of, and names nothing where
   // one of them lies. On the older engine the surface is not asked at all: PixInsight itself
   // went down there, when asked what lies at a point on the frame of a text box.
   function controlsOf( dialog )
   {
      var found = [];
      function add( control )
      {
         if ( !isControl( control ) || control === dialog )
            return;
         control = whole( dialog, control );
         if ( found.indexOf( control ) >= 0 )
            return;
         found.push( control );
         // A scroll box shows an area of its own, which a script draws on and which nothing else names.
         var area = null;
         try
         {
            if ( kindOf( control ) === "Control" && typeof control.viewport === "object" )
               area = control.viewport;
         }
         catch ( error )
         {
         }
         if ( area !== null )
            add( area );
      }

      if ( v8 )
      {
         if ( baseNames === null )
         {
            // On V8 a dialog carries its own members itself, next to what the script adds.
            baseNames = {};
            var own = Object.getOwnPropertyNames( new NativeDialog );
            for ( var b = 0; b < own.length; b++ )
               baseNames[own[b]] = true;
         }
         var names = Object.getOwnPropertyNames( dialog );
         for ( var n = 0; n < names.length; n++ )
         {
            if ( owns( baseNames, names[n] ) )
               continue;
            var value;
            try
            {
               value = dialog[names[n]];
            }
            catch ( error )
            {
               continue;
            }
            if ( value instanceof Array )
               for ( var a = 0; a < value.length && a < 300; a++ )
                  add( value[a] );
            else
               add( value );
         }
         var alive = [];
         for ( var m = 0; m < made.length; m++ )
         {
            var one = made[m].deref();
            if ( one === undefined )
               continue;
            alive.push( made[m] );
            if ( ownerOf( one ) === dialog )
               add( one );
         }
         made = alive;
         var width = dialog.width, height = dialog.height;
         var step = Math.max( 5, Math.ceil( Math.sqrt( width * height / MAX_SAMPLES ) ) );
         for ( var y = 2; y < height; y += step )
            for ( var x = 2; x < width; x += step )
               add( deepest( dialog, x, y ) );
         return found;
      }
      gather( dialog, dialog, 0, [], add );
      for ( var l = 0; l < made.length; l++ )
         if ( ownerOf( made[l] ) === dialog )
            add( made[l] );
      return found;
   }

   // Whether a point of the dialog lies inside a control and inside everything the control lies
   // in: what its parent cuts off, a user cannot click either.
   function holds( dialog, control, x, y )
   {
      for ( var steps = 0; control !== null && control !== dialog && steps < 20; steps++ )
      {
         var rect = rectOf( dialog, control );
         if ( x < rect[0] || y < rect[1] || x >= rect[0] + rect[2] || y >= rect[1] + rect[3] )
            return false;
         control = parentOf( control );
      }
      return true;
   }

   function within( control, outer )
   {
      for ( var steps = 0; control !== null && steps < 20; steps++ )
      {
         control = parentOf( control );
         if ( control === outer )
            return true;
      }
      return false;
   }

   // What lies at a point, among the controls that are known: the smallest one there, and of two
   // of one size the one inside the other, which is the one on top. For the older engine, where
   // PixInsight is not asked.
   function under( dialog, x, y )
   {
      var found = controlsOf( dialog );
      var best = null, size = 0;
      for ( var i = 0; i < found.length; i++ )
      {
         if ( !shown( found[i] ) || !holds( dialog, found[i], x, y ) )
            continue;
         var area = found[i].width * found[i].height;
         if ( best === null || area < size || ( area === size && within( found[i], best ) ) )
         {
            best = found[i];
            size = area;
         }
      }
      return best;
   }

   function parentOf( control )
   {
      try
      {
         var parent = control.parent;
         return isControl( parent ) ? parent : null;
      }
      catch ( error )
      {
         return null;
      }
   }

   // What a field shows that does not change with its value, for the kinds of which a script
   // keeps two in one place and shows them in turns, as WBPP does with its tables.
   function signOf( control, kind )
   {
      if ( kind !== "TreeBox" )
         return null;
      var headers = [];
      for ( var c = 0; c < control.numberOfColumns && c < MAX_DETAIL_COLUMNS; c++ )
         headers.push( String( control.headerText( c ) ) );
      return JSON.stringify( headers );
   }

   function shown( control )
   {
      try
      {
         return control.visible === true;
      }
      catch ( error )
      {
         return false;
      }
   }

   function slotOf( control )
   {
      // From the end: a dialog that is open now was named after those that are gone.
      for ( var i = slots.length; --i >= 0; )
         if ( slots[i].controls.indexOf( control ) >= 0 )
            return i;
      return -1;
   }

   // Whether another control of this slot shows as well.
   function sharesWith( slot, control )
   {
      for ( var i = 0; i < slot.controls.length; i++ )
         if ( slot.controls[i] !== control && shown( slot.controls[i] ) )
            return true;
      return false;
   }

   function showsOne( slot )
   {
      for ( var i = 0; i < slot.controls.length; i++ )
         if ( shown( slot.controls[i] ) )
            return true;
      return false;
   }

   // The name of a field. A control keeps its name. One that turns up in the very place of
   // another that is hidden now, in the same parent and with the same look, takes over the name
   // of that one: to a reader it is the same field.
   function idOf( dialog, control, kind )
   {
      var index = slotOf( control );
      var rect = rectOf( dialog, control );
      // Two that took turns under one name and show at once now are two fields: this one gets a name of its own.
      if ( index >= 0 && slots[index].controls.length > 1 && sharesWith( slots[index], control ) )
      {
         slots[index].controls.splice( slots[index].controls.indexOf( control ), 1 );
         index = slots.push( { controls: [ control ], sign: null, parent: null, rect: rect } ) - 1;
      }
      if ( index < 0 )
      {
         var sign = signOf( control, kind );
         var parent = parentOf( control );
         if ( sign !== null )
            for ( var i = 0; i < slots.length && index < 0; i++ )
               if ( slots[i].sign === sign && slots[i].parent === parent && slots[i].rect.join() === rect.join() && !showsOne( slots[i] ) )
                  index = i;
         if ( index < 0 )
            index = slots.push( { controls: [], sign: sign, parent: parent, rect: rect } ) - 1;
         slots[index].controls.push( control );
      }
      slots[index].rect = rect;
      return "f" + ( index + 1 );
   }

   // A field that hides what is typed keeps its content to itself for good, also after the script
   // or the user has made it show what it holds.
   function isSecret( control, kind )
   {
      if ( kind !== "Edit" )
         return false;
      if ( control.passwordMode === true && secrets.indexOf( control ) < 0 )
         secrets.push( control );
      return secrets.indexOf( control ) >= 0;
   }

   function optionsOf( control )
   {
      var options = [];
      for ( var i = 0; i < control.numberOfItems; i++ )
         options.push( line( control.itemText( i ), MAX_TEXT ) );
      return options;
   }

   function pagesOf( control )
   {
      var pages = [];
      for ( var i = 0; i < control.numberOfPages; i++ )
         pages.push( line( control.pageLabel( i ), MAX_TEXT ) );
      return pages;
   }

   // A long text: the part that is asked for, and how much of it comes after.
   function textInto( field, text, how, max )
   {
      var all = String( text );
      if ( how.from === null )
      {
         field.value = clip( all, max );
         if ( all.length > max )
            field.more = all.length - max + 1;
         return;
      }
      var start = Math.min( how.from, all.length );
      field.value = all.substring( start, start + MAX_DETAIL_TEXT );
      if ( start > 0 )
         field.from = start;
      if ( all.length > start + MAX_DETAIL_TEXT )
         field.more = all.length - start - MAX_DETAIL_TEXT;
   }

   // Every row of a table in the order a reader meets them, rows inside rows included. The place
   // of a row in that order is its number. Returns how many rows there are, or how many were
   // met when `visit` said to stop.
   function eachRow( control, visit )
   {
      var count = 0;
      var stopped = false;
      function walk( node, level )
      {
         if ( visit( node, count++, level ) === false )
         {
            stopped = true;
            return;
         }
         var inner = node.numberOfChildren;
         for ( var k = 0; k < inner && !stopped; k++ )
            walk( node.child( k ), level + 1 );
      }
      var top = control.numberOfChildren;
      for ( var r = 0; r < top && !stopped; r++ )
         walk( control.child( r ), 0 );
      return count;
   }

   // The text of each cell. A cell that shows a picture has none: PixInsight hands out an empty
   // picture for it, so nothing tells such a cell from an empty one.
   function cellsOf( node, columns )
   {
      var cells = [];
      for ( var c = 0; c < columns.length; c++ )
         cells.push( line( node.text( columns[c] ), MAX_TEXT ) );
      return cells;
   }

   // A table. In the list of a dialog: its rows as deep as fit, each with its number, and how
   // many lie inside a row that is not opened up here. Read by itself: every row from one number on.
   function tableInto( field, control, how )
   {
      var detail = how.from !== null;
      var visible = [];
      for ( var c = 0; c < control.numberOfColumns; c++ )
      {
         var seen = true;
         try
         {
            seen = control.isColumnVisible( c ) !== false;
         }
         catch ( error )
         {
         }
         if ( seen )
            visible.push( c );
      }
      var columns = visible.slice( 0, detail ? MAX_DETAIL_COLUMNS : MAX_COLUMNS );
      field.columns = [];
      for ( var h = 0; h < columns.length; h++ )
         field.columns.push( line( control.headerText( columns[h] ), MAX_TEXT ) );
      if ( visible.length > columns.length )
         field.moreColumns = visible.length - columns.length;
      // A last column without a heading and without a word in any row only fills the width.
      var last = columns.length - 1;
      var filler = last > 0 && field.columns[last] === "";

      // A first walk over every row: how many lie on each level, which one is selected, and
      // whether the last column says anything.
      var perLevel = [];
      var selected = null;
      field.value = null;
      var total = eachRow( control, function( node, number, level )
      {
         if ( perLevel.length <= level )
            perLevel.push( 0 );
         perLevel[level]++;
         if ( field.value === null && node.selected === true )
         {
            field.value = number;
            selected = node;
         }
         if ( filler && node.text( columns[last] ) !== "" )
            filler = false;
         return true;
      } );
      if ( filler )
      {
         columns.pop();
         field.columns.pop();
      }
      if ( selected !== null )
         field.selected = cellsOf( selected, columns );

      // As deep as the rows fit into the list of a dialog.
      var deep = 0, fit = 0;
      for ( var l = 0; l < perLevel.length && fit + perLevel[l] <= MAX_ROWS; l++ )
      {
         fit += perLevel[l];
         deep = l;
      }
      var first = detail ? how.from : 0;
      var limit = detail ? MAX_DETAIL_ROWS : MAX_ROWS;
      var next = first;
      field.rows = [];
      // A second walk for the rows that are listed.
      eachRow( control, function( node, number, level )
      {
         if ( number < first || ( !detail && level > deep ) )
            return true;
         if ( field.rows.length >= limit )
            return false;
         var row = { row: number };
         if ( level > 0 )
            row.level = level;
         row.cells = cellsOf( node, columns );
         // Every row can be ticked as far as PixInsight tells, so only a tick says something.
         if ( node.checked === true )
            row.checked = true;
         if ( !detail && level === deep && node.numberOfChildren > 0 )
            row.inside = node.numberOfChildren;
         field.rows.push( row );
         next = number + 1;
         return true;
      } );
      if ( detail )
      {
         field.totalRows = total;
         if ( first > 0 )
            field.from = first;
         if ( total > next )
            field.moreRows = total - next;
      }
      else if ( total > field.rows.length )
         field.moreRows = total - field.rows.length;
   }

   // @param how.help Whether to add the tooltip of the field.
   // @param how.from Null for the list of a dialog. Else the field is read by itself, in full,
   //    from this row or this character on.
   // @param how.text How much of a text box the list of a dialog shows.
   function describeField( dialog, control, how )
   {
      if ( control.visible !== true )
         return null;
      var kind = kindOf( control );
      var detail = how.from !== null;
      var field = { id: null, type: kind };
      switch ( kind )
      {
      case "Label":
         field.text = control.useRichText === true ? plain( control.text, detail ? MAX_DETAIL_TEXT : MAX_TEXT ) : line( control.text, detail ? MAX_DETAIL_TEXT : MAX_TEXT );
         if ( field.text === "" )
            return null;
         break;
      case "Edit":
         if ( isSecret( control, kind ) )
            field.secret = true;
         else
            textInto( field, control.text, how, MAX_TEXT );
         if ( control.readOnly === true )
            field.readOnly = true;
         break;
      case "TextBox":
         textInto( field, control.text, how, how.text );
         if ( control.readOnly === true )
            field.readOnly = true;
         break;
      case "CheckBox":
      case "RadioButton":
         field.text = line( control.text, MAX_TEXT );
         field.value = control.checked === true;
         break;
      case "PushButton":
         field.text = line( control.text, MAX_TEXT );
         break;
      case "ToolButton":
         field.text = line( control.text, MAX_TEXT );
         if ( control.checkable === true )
            field.value = control.checked === true;
         break;
      case "ComboBox":
         var options = optionsOf( control );
         var most = detail ? 10 * MAX_OPTIONS : MAX_OPTIONS;
         field.options = options.slice( 0, most );
         if ( options.length > most )
            field.moreOptions = options.length - most;
         field.value = control.currentItem >= 0 && control.currentItem < options.length ? options[control.currentItem] : null;
         if ( control.editEnabled === true )
         {
            field.editable = true;
            field.value = clip( control.editText, MAX_TEXT );
         }
         break;
      case "SpinBox":
      case "Slider":
         field.value = control.value;
         field.range = [ control.minValue, control.maxValue ];
         break;
      case "NumericControl":
      case "NumericEdit":
         field.text = line( control.label.text, MAX_TEXT );
         field.value = control.value;
         field.range = [ control.lowerBound, control.upperBound ];
         break;
      case "ViewList":
         field.value = control.currentView && !control.currentView.isNull ? control.currentView.fullId : null;
         break;
      case "GroupBox":
         field.text = line( control.title, MAX_TEXT );
         if ( control.titleCheckBox === true )
            field.value = control.checked === true;
         else if ( field.text === "" )
            return null;
         break;
      case "TabBox":
         var pages = pagesOf( control );
         field.options = pages.slice( 0, MAX_OPTIONS );
         field.value = control.currentPageIndex >= 0 && control.currentPageIndex < pages.length ? pages[control.currentPageIndex] : null;
         break;
      case "TreeBox":
         tableInto( field, control, how );
         break;
      default:
         // A bare control is worth a line only if the script draws on it or takes clicks there.
         var clicks = has( control, "onMousePress" ) || has( control, "onMouseRelease" );
         if ( !clicks && !has( control, "onPaint" ) )
            return null;
         field.drawn = true;
         if ( clicks )
            field.clicks = true;
      }
      if ( control.enabled !== true )
         field.enabled = false;
      field.at = rectOf( dialog, control );
      // A button that shows only a picture says nothing without its tooltip.
      var mute = ( kind === "PushButton" || kind === "ToolButton" || kind === "CheckBox" || kind === "RadioButton" ) && field.text === "";
      if ( ( how.help || mute ) && control.toolTip )
         field.help = plain( control.toolTip, how.help ? 2 * MAX_TEXT : MAX_TEXT / 2 );
      field.id = idOf( dialog, control, kind );
      return field;
   }

   function describe( dialog, withHelp )
   {
      lookUpClasses();
      var found = controlsOf( dialog );
      // A dialog that is mostly one text shows more of it.
      var texts = 0;
      for ( var t = 0; t < found.length; t++ )
         if ( found[t].visible === true && kindOf( found[t] ) === "TextBox" )
            texts++;
      var how = { help: withHelp, from: null, text: Math.max( 4 * MAX_TEXT, Math.floor( MAX_OVERVIEW_TEXT / Math.max( 1, texts ) ) ) };
      var fields = [];
      for ( var i = 0; i < found.length; i++ )
      {
         var field;
         try
         {
            field = describeField( dialog, found[i], how );
         }
         catch ( error )
         {
            field = null;
         }
         if ( field !== null )
            fields.push( field );
      }
      // In reading order: by row, then from left to right.
      fields.sort( function( a, b )
      {
         var rowA = Math.round( ( a.at[1] + a.at[3] / 2 ) / 12 ), rowB = Math.round( ( b.at[1] + b.at[3] / 2 ) / 12 );
         return rowA !== rowB ? rowA - rowB : a.at[0] - b.at[0];
      } );
      var result = { dialog: nameOf( dialog ), title: line( dialog.windowTitle, MAX_TEXT ), size: [ dialog.width, dialog.height ], fields: fields.slice( 0, MAX_FIELDS ) };
      if ( fields.length > MAX_FIELDS )
         result.moreFields = fields.length - MAX_FIELDS;
      return result;
   }

   // One field by itself and in full: every row of a table, or all of a long text.
   function describeOne( dialog, id, from, withHelp )
   {
      lookUpClasses();
      var control = controlOf( dialog, id );
      var field = describeField( dialog, control, { help: withHelp, from: typeof from === "number" && from > 0 ? Math.floor( from ) : 0, text: MAX_DETAIL_TEXT } );
      if ( field === null )
         refuse( "unknown_field", "Field " + id + " shows nothing that can be read." );
      return { dialog: nameOf( dialog ), title: line( dialog.windowTitle, MAX_TEXT ), field: field };
   }

   // A picture of the dialog as PixInsight paints it, with every secret field painted over. A
   // field in password mode shows dots, but not one that was made to show what it holds.
   function render( dialog, path )
   {
      lookUpClasses();
      var found = controlsOf( dialog );
      var bitmap = dialog.render();
      var covered = 0;
      var graphics = null;
      for ( var i = 0; i < found.length; i++ )
      {
         var hidden;
         try
         {
            hidden = found[i].visible === true && isSecret( found[i], kindOf( found[i] ) );
         }
         catch ( error )
         {
            hidden = false;
         }
         if ( !hidden )
            continue;
         if ( graphics === null )
            graphics = new Graphics( bitmap );
         var rect = rectOf( dialog, found[i] );
         graphics.fillRect( new Rect( rect[0], rect[1], rect[0] + rect[2], rect[1] + rect[3] ), new Brush( COVER ) );
         covered++;
      }
      if ( graphics !== null )
         graphics.end();
      bitmap.save( path );
      return { dialog: nameOf( dialog ), size: [ bitmap.width, bitmap.height ], covered: covered };
   }

   // ------------------------------------------------------------------------------------------
   // Working a dialog
   // ------------------------------------------------------------------------------------------

   // What a click does is done by the handler of the script.
   function fire( control, handler, args, fired )
   {
      if ( !has( control, handler ) )
         return;
      fired.push( handler );
      control[handler].apply( control, args );
   }

   // Changes a control and tells the script of it, as a change by the user would. Setting a
   // property tells a script nothing, except where PixInsight does tell it, which differs between
   // its engines. So each handler is watched while the change is made, and called afterwards only
   // if PixInsight has not called it. `handlers` holds, for each, its name and what gives its
   // arguments once the change is made.
   function change( control, make, handlers, fired )
   {
      var told = [];
      var own = [];
      function watch( i )
      {
         var name = handlers[i][0];
         var original = control[name];
         own[i] = original;
         control[name] = function()
         {
            told[i] = true;
            return original.apply( this, arguments );
         };
      }
      for ( var i = 0; i < handlers.length; i++ )
      {
         told[i] = false;
         own[i] = null;
         if ( has( control, handlers[i][0] ) )
            watch( i );
      }
      try
      {
         make();
      }
      finally
      {
         for ( var j = 0; j < handlers.length; j++ )
            if ( own[j] !== null )
               control[handlers[j][0]] = own[j];
      }
      for ( var k = 0; k < handlers.length; k++ )
         if ( told[k] )
            fired.push( handlers[k][0] );
         else
            fire( control, handlers[k][0], handlers[k][1](), fired );
   }

   // The control that a field name stands for in the dialog that is open now.
   function controlOf( dialog, id )
   {
      var match = /^f(\d+)$/.exec( String( id ) );
      var index = match ? Number( match[1] ) - 1 : -1;
      if ( index < 0 || index >= slots.length )
         refuse( "unknown_field", "The dialog has no field " + id + ". Read it again with get_script_dialog." );
      var held = slots[index].controls;
      var control = null;
      for ( var i = 0; i < held.length; i++ )
         if ( ownerOf( held[i] ) === dialog && shown( held[i] ) )
         {
            // Two that took turns under this name show at once: which one is meant, only a new look can say.
            if ( control !== null )
               refuse( "unknown_field", "Field " + id + " stands for two fields now. Read the dialog again with get_script_dialog." );
            control = held[i];
         }
      if ( control === null )
         refuse( "unknown_field", "Field " + id + " is not in the dialog that is open now (" + line( dialog.windowTitle, 80 ) + "). Read it again with get_script_dialog." );
      return control;
   }

   function fieldOf( dialog, id )
   {
      var control = controlOf( dialog, id );
      if ( control.enabled !== true )
         refuse( "field_disabled", "Field " + id + " is disabled, as it would be for the user. Another setting of the dialog decides when it can be used." );
      return control;
   }

   function labelOf( control, kind )
   {
      var text = "";
      try
      {
         text = kind === "NumericControl" || kind === "NumericEdit" ? control.label.text : kind === "GroupBox" ? control.title : ( typeof control.text === "string" ? control.text : "" );
      }
      catch ( error )
      {
      }
      return kind + ( text && kind !== "Edit" ? " \"" + line( text, 60 ) + "\"" : "" );
   }

   function numberFrom( value, id )
   {
      var number = typeof value === "number" ? value : typeof value === "string" && value !== "" ? Number( value ) : NaN;
      if ( !isFinite( number ) )
         refuse( "invalid_value", "Field " + id + " takes a number, not " + JSON.stringify( value ) + "." );
      return number;
   }

   // The option that is meant: by its text first, because an option can be called "2", and only
   // then by its number.
   function indexIn( options, value, id, what )
   {
      var wanted = String( value ).replace( /^\s+|\s+$/g, "" ).toLowerCase();
      var matches = [];
      for ( var i = 0; i < options.length; i++ )
         if ( options[i].toLowerCase() === wanted )
            matches.push( i );
      if ( matches.length === 1 )
         return matches[0];
      if ( matches.length > 1 )
         refuse( "invalid_value", "Field " + id + " has " + matches.length + " " + what + "s called " + JSON.stringify( value ) + ". Pass the number of the one you mean, counted from 0." );
      if ( typeof value === "number" && value >= 0 && value < options.length && Math.floor( value ) === value )
         return value;
      refuse( "invalid_value", "Field " + id + " has no " + what + " " + JSON.stringify( value ) + ". It has: " + options.slice( 0, MAX_OPTIONS ).join( ", " ) + "." );
      return -1;
   }

   function set( dialog, id, value, fired )
   {
      var control = fieldOf( dialog, id );
      var kind = kindOf( control );
      // Said before the script is told, so that it is in the console also if the script fails over it.
      function tell( row )
      {
         note( kind === "TreeBox" ? "selected row " + value + " of a table (" + line( row.join( ", " ), 120 ) + ")" : "set " + labelOf( control, kind ) + " to " + JSON.stringify( value ) );
      }
      switch ( kind )
      {
      case "Edit":
         if ( isSecret( control, kind ) )
            refuse( "secret_field", "Field " + id + " takes a password or a key, which only the user enters. Ask the user to type it into the dialog." );
         if ( control.readOnly === true )
            refuse( "not_settable", "Field " + id + " is read-only." );
         if ( typeof value !== "string" && typeof value !== "number" )
            refuse( "invalid_value", "Field " + id + " takes a text." );
         tell();
         change( control, function() { control.text = String( value ); },
            [ [ "onTextUpdated", function() { return [ control.text ]; } ], [ "onEditCompleted", function() { return []; } ] ], fired );
         break;
      case "CheckBox":
      case "RadioButton":
      case "GroupBox":
         if ( typeof value !== "boolean" )
            refuse( "invalid_value", "Field " + id + " takes true or false." );
         if ( kind === "GroupBox" && control.titleCheckBox !== true )
            refuse( "not_settable", "Field " + id + " is a group without a check box." );
         if ( control.checked !== value )
         {
            tell();
            change( control, function() { control.checked = value; },
               kind === "GroupBox" ? [ [ "onCheck", function() { return [ value ]; } ] ] : [ [ "onCheck", function() { return [ value ]; } ], [ "onClick", function() { return [ value ]; } ] ], fired );
         }
         break;
      case "ComboBox":
         var options = optionsOf( control );
         if ( control.editEnabled === true && typeof value === "string" && options.indexOf( line( value, MAX_TEXT ) ) < 0 )
         {
            tell();
            change( control, function() { control.editText = value; }, [ [ "onEditTextUpdated", function() { return [ value ]; } ] ], fired );
            break;
         }
         var item = indexIn( options, value, id, "option" );
         tell();
         change( control, function() { control.currentItem = item; }, [ [ "onItemSelected", function() { return [ item ]; } ] ], fired );
         break;
      case "SpinBox":
      case "Slider":
         var integer = numberFrom( value, id );
         if ( Math.floor( integer ) !== integer || integer < control.minValue || integer > control.maxValue )
            refuse( "invalid_value", "Field " + id + " takes a whole number from " + control.minValue + " to " + control.maxValue + "." );
         tell();
         change( control, function() { control.value = integer; }, [ [ "onValueUpdated", function() { return [ integer ]; } ] ], fired );
         break;
      case "NumericControl":
      case "NumericEdit":
         var number = numberFrom( value, id );
         if ( number < control.lowerBound || number > control.upperBound )
            refuse( "invalid_value", "Field " + id + " takes a number from " + control.lowerBound + " to " + control.upperBound + "." );
         tell();
         change( control, function() { control.setValue( number ); }, [ [ "onValueUpdated", function() { return [ control.value ]; } ] ], fired );
         break;
      case "TabBox":
         var page = indexIn( pagesOf( control ), value, id, "page" );
         tell();
         change( control, function() { control.currentPageIndex = page; }, [ [ "onPageSelected", function() { return [ page ]; } ] ], fired );
         break;
      case "ViewList":
         var view = View.viewById( String( value ) );
         if ( view === null || view.isNull )
            refuse( "invalid_value", "No image or preview " + JSON.stringify( value ) + " is open." );
         // Asked first with nobody listening, so that a view the list does not offer changes nothing.
         var current = control.currentView;
         var offered;
         change( control, function()
         {
            control.currentView = view;
            offered = !control.currentView.isNull && control.currentView.fullId === view.fullId;
            if ( !offered )
               control.currentView = current;
         }, [], fired );
         if ( !offered )
            refuse( "invalid_value", "The list of field " + id + " does not offer " + view.fullId + "." );
         control.currentView = current;
         tell();
         change( control, function() { control.currentView = view; },
            [ [ "onCurrentViewUpdated", function() { return [ view ]; } ], [ "onViewSelected", function() { return [ view ]; } ] ], fired );
         break;
      case "TreeBox":
         var row = numberFrom( value, id );
         var node = null;
         var rows = eachRow( control, function( each, number )
         {
            if ( number !== row )
               return true;
            node = each;
            return false;
         } );
         if ( node === null )
            refuse( "invalid_value", rows === 0 ? "The table of field " + id + " has no rows." : "Field " + id + " has the rows 0 to " + ( rows - 1 ) + ", counted as \"row\" says for each. Pass the number of the row to select." );
         var cells = [];
         for ( var c = 0; c < control.numberOfColumns && cells.length < 6; c++ )
            if ( node.text( c ) !== "" )
               cells.push( line( node.text( c ), 40 ) );
         // A row inside rows that are folded up has to show before a user could select it.
         for ( var above = node.parent, steps = 0; above !== null && typeof above === "object" && above instanceof TreeBoxNode && steps < 50; above = above.parent, steps++ )
            if ( above.expanded !== true )
               above.expanded = true;
         var before = control.currentNode;
         tell( cells );
         // On V8 a table tells the script of its current row by itself.
         change( control, function() { control.currentNode = node; },
            [ [ "onCurrentNodeUpdated", function() { return [ node, before ]; } ], [ "onNodeSelectionUpdated", function() { return []; } ], [ "onNodeClicked", function() { return [ node, 0 ]; } ] ], fired );
         // Scrolled to, so that the user and a picture see it. V8 warns about the older name of this.
         try
         {
            if ( typeof control.setNodeIntoViewport === "function" )
               control.setNodeIntoViewport( node );
            else
               control.setNodeIntoView( node );
         }
         catch ( error )
         {
         }
         break;
      default:
         refuse( "not_settable", "Field " + id + " is a " + kind + ", which takes no value." + ( kind === "PushButton" || kind === "ToolButton" ? " Press it." : "" ) );
      }
   }

   function pressControl( control, kind, id, fired )
   {
      if ( kind === "CheckBox" || kind === "RadioButton" )
         refuse( "not_a_button", "Field " + id + " is a " + kind + ". Set it to true or false." );
      var toggles = kind === "ToolButton" && control.checkable === true;
      // Asked before anything is changed: a button with nothing to do stays as it is.
      if ( !has( control, "onPress" ) && !has( control, "onRelease" ) && !has( control, "onClick" ) && !( toggles && has( control, "onCheck" ) ) )
         refuse( "no_effect", "The script has given field " + id + " (" + kind + ") nothing to do when it is pressed." );
      note( "pressed " + labelOf( control, kind ) );
      fire( control, "onPress", [], fired );
      fire( control, "onRelease", [], fired );
      var checked = false;
      if ( toggles )
      {
         control.checked = !control.checked;
         checked = control.checked === true;
         fire( control, "onCheck", [ checked ], fired );
      }
      fire( control, "onClick", [ checked ], fired );
   }

   function press( dialog, id, fired )
   {
      var control = fieldOf( dialog, id );
      pressControl( control, kindOf( control ), id, fired );
   }

   // A click is for what the script draws itself. On a field it would tell the script of a click
   // that changed nothing, which no user can do, so a field is worked as a field.
   function click( dialog, x, y, fired )
   {
      if ( typeof x !== "number" || typeof y !== "number" || x < 0 || y < 0 || x >= dialog.width || y >= dialog.height )
         refuse( "invalid_value", "The dialog is " + dialog.width + " by " + dialog.height + " pixels. Pass a point inside it." );
      var control = v8 ? deepest( dialog, x, y ) : under( dialog, x, y );
      if ( control !== null )
         control = whole( dialog, control );
      // A control that takes no clicks can lie on one that does.
      for ( var depth = 0; depth < 20 && control !== null; depth++ )
      {
         if ( kindOf( control ) !== "Control" || has( control, "onMousePress" ) || has( control, "onMouseRelease" ) )
            break;
         var parent = control.parent;
         control = isControl( parent ) && parent !== dialog ? parent : null;
      }
      if ( control === null )
         refuse( "no_effect", "Nothing at " + x + ", " + y + " takes a click from the script's own code. Use the fields of the dialog instead." );
      if ( control.enabled !== true || control.visible !== true )
         refuse( "field_disabled", "What lies at " + x + ", " + y + " is disabled." );
      var kind = kindOf( control );
      var id = idOf( dialog, control, kind );
      if ( kind === "PushButton" || kind === "ToolButton" )
      {
         pressControl( control, kind, id, fired );
         return id;
      }
      if ( kind !== "Control" )
         refuse( "not_clickable", "At " + x + ", " + y + " lies field " + id + ", a " + kind + ". Give it a value with the action set." );
      var rect = rectOf( dialog, control );
      note( "clicked at " + x + ", " + y );
      fire( control, "onMousePress", [ x - rect[0], y - rect[1], LEFT_BUTTON, LEFT_BUTTON, 0 ], fired );
      fire( control, "onMouseRelease", [ x - rect[0], y - rect[1], LEFT_BUTTON, 0, 0 ], fired );
      return id;
   }

   function perform( dialog, command )
   {
      if ( command.act === "describe" )
         return typeof command.field === "string" ? describeOne( dialog, command.field, command.from, command.help ? true : false ) : describe( dialog, command.help ? true : false );
      if ( command.act === "render" )
         return render( dialog, command.path );
      if ( !operate )
         refuse( "read_only", "The dialogs of scripts can only be read here, because the user has set it so." );
      if ( question !== null )
         refuse( "question_open", "The script asks something first. Answer it." );
      lookUpClasses();
      var fired = [];
      var result = { fired: fired };
      try
      {
         switch ( command.act )
         {
         case "set":
            set( dialog, command.field, command.value, fired );
            break;
         case "press":
            press( dialog, command.field, fired );
            break;
         case "click":
            result.field = click( dialog, command.x, command.y, fired );
            break;
         case "close":
            note( "closed the dialog \"" + line( dialog.windowTitle, 80 ) + "\"" );
            dialog.cancel();
            break;
         default:
            refuse( "internal_error", "Unknown action " + command.act + "." );
         }
      }
      catch ( error )
      {
         if ( kindIn( error ) !== null )
            throw error;
         // The script's own handler failed, after the value was set.
         refuse( "script_error", "The script failed while it handled this (" + fired.join( ", " ) + "): " + textIn( error ) );
      }
      return result;
   }

   function serve( dialog )
   {
      var timer = new Timer;
      var ticksOnTop = 0;
      var closing = false;
      timer.interval = TICK_SECONDS;
      timer.periodic = true;
      timer.onTimeout = function()
      {
         if ( v8 )
         {
            // On V8 nothing says when a dialog is opened or closed, so its timer looks.
            if ( dialog.visible === true )
               noteOpen( dialog );
            else
               noteClosed( dialog );
         }
         else if ( closing && dialog.visible !== true )
         {
            // On the older engine this timer only runs while the dialog waits to be closed. So it
            // was closed and waits all the same, which a close in an unlucky moment can do.
            dialog.show();
            dialog.cancel();
            return;
         }
         var top = topDialog();
         if ( top !== dialog )
         {
            ticksOnTop = 0;
            // On V8 these timers also run while no dialog is open, and one of them says so.
            if ( top === null )
               noteState();
            return;
         }
         if ( !awaited() )
            return;
         noteState();
         // Nothing is done to a dialog in the tick it appears in: PixInsight may still be bringing it up.
         if ( ++ticksOnTop < 2 )
            return;
         var path = jobDir + "/dialog-cmd.json";
         if ( !File.exists( path ) )
            return;
         var command;
         try
         {
            command = JSON.parse( File.readTextFile( path ) );
            // Whoever removes the file has the command: the server takes back what was not taken.
            File.remove( path );
         }
         catch ( error )
         {
            return;
         }
         var reply;
         try
         {
            // Meant for a dialog that is not the one on top any more, or not in this showing.
            if ( command.dialog !== null && command.dialog !== nameOf( dialog ) )
               refuse( "dialog_changed", "The script shows something else now than when this was asked for, so nothing was done. Read it again with get_script_dialog." );
            var result = perform( dialog, command );
            if ( command.act === "close" )
               closing = true;
            reply = { ok: true, result: result };
         }
         catch ( error )
         {
            reply = { ok: false, error: { kind: kindIn( error ) !== null ? kindIn( error ) : "script_error", message: textIn( error ) } };
         }
         try
         {
            put( "dialog-reply-" + command.id + ".json", reply );
         }
         catch ( error )
         {
         }
         noteState();
      };
      timer.start();
      timers.push( timer );
      return timer;
   }

   function forget( timer )
   {
      timer.stop();
      var at = timers.indexOf( timer );
      if ( at >= 0 )
         timers.splice( at, 1 );
   }

   // ------------------------------------------------------------------------------------------
   // What a script asks in a window of PixInsight's own, which nothing can answer from outside
   // ------------------------------------------------------------------------------------------

   // Shown in place of such a window: the user can answer here as before, and so can the server,
   // through a file. Returns the value of the choice and whether it came from the server, or null
   // if the window was just closed.
   function prompt( asked, title, text, choices, preset )
   {
      var dialog = new NativeDialog;
      var chosen = null;
      dialog.windowTitle = title;
      var message = new Label( dialog );
      message.useRichText = true;
      message.wordWrapping = true;
      message.text = text;
      message.setScaledMinWidth( 420 );
      var hint = new Label( dialog );
      hint.text = "The assistant can answer this as well.";
      hint.enabled = false;
      var buttons = new Sizer( false );
      buttons.spacing = 6;
      buttons.addStretch();
      var kept = [];
      function addChoice( choice, isPreset )
      {
         var button = new PushButton( dialog );
         button.text = choice.label;
         // The button that the Enter key presses, as in the window this one stands for.
         if ( isPreset )
            button.defaultButton = true;
         button.onClick = function()
         {
            chosen = { answered: false, value: choice.value };
            dialog.ok();
         };
         buttons.add( button );
         kept.push( button );
      }
      for ( var i = 0; i < choices.length; i++ )
         addChoice( choices[i], i === preset );
      var layout = new Sizer( true );
      layout.margin = 12;
      layout.spacing = 10;
      layout.add( message );
      layout.add( hint );
      layout.add( buttons );
      dialog.sizer = layout;
      dialog.adjustToContents();

      // A script can ask while it already waits for an answer, in a handler that a timer calls.
      var outer = question;
      asked.id = ++questions;
      question = asked;
      noteState();
      var answerPath = jobDir + "/dialog-answer-" + asked.id + ".json";
      var timer = new Timer;
      var ticksShown = 0;
      timer.interval = TICK_SECONDS;
      timer.periodic = true;
      timer.onTimeout = function()
      {
         // An answer can be there before the window is, or while PixInsight is still bringing the
         // window up. Closing it then does not end its wait, so the answer is only taken once the
         // window has been there for a tick, and the closing is repeated until the wait is over.
         if ( dialog.visible !== true )
         {
            ticksShown = 0;
            if ( chosen !== null )
            {
               dialog.show();
               dialog.ok();
            }
            return;
         }
         if ( chosen !== null )
         {
            dialog.ok();
            return;
         }
         if ( ++ticksShown < 2 || !File.exists( answerPath ) )
            return;
         try
         {
            chosen = { answered: true, value: JSON.parse( File.readTextFile( answerPath ) ).value };
            File.remove( answerPath );
         }
         catch ( error )
         {
            return;
         }
         dialog.ok();
      };
      timer.start();
      // In the list, so that the clean-up of the older engine stops it if the script never gets back here.
      timers.push( timer );
      try
      {
         if ( nativeExecute )
            nativeExecute.call( dialog );
         else
            dialog.execute();
      }
      finally
      {
         forget( timer );
         question = outer;
         noteState();
      }
      return chosen;
   }

   function buttonsOf( box )
   {
      var codes = [ box.firstButton, box.secondButton, box.thirdButton ];
      var found = [];
      for ( var i = 0; i < codes.length; i++ )
         if ( codes[i] > 0 && codes[i] < BUTTONS.length )
            found.push( codes[i] );
      return found.length > 0 ? found : [ 1 ];
   }

   // The button that the Esc key and the close button of the window stand for, or 0 if the
   // message box has none, in which case it cannot be closed without a choice.
   function escapeOf( box, codes )
   {
      var all = [ box.firstButton, box.secondButton, box.thirdButton ];
      var chosen = box.escapeButton >= 0 && box.escapeButton < 3 ? all[box.escapeButton] : 0;
      if ( codes.indexOf( chosen ) >= 0 )
         return chosen;
      return codes.length === 1 ? codes[0] : codes.indexOf( 2 ) >= 0 ? 2 : codes.indexOf( 4 ) >= 0 ? 4 : 0;
   }

   // The code of the button a message box ends with, or undefined if it is to be shown as
   // PixInsight would show it.
   function askMessage( box )
   {
      var codes = buttonsOf( box );
      var choices = [];
      var names = [];
      for ( var i = 0; i < codes.length; i++ )
      {
         var name = BUTTONS[codes[i]];
         names.push( name );
         choices.push( { label: name === "ok" ? "OK" : name.charAt( 0 ).toUpperCase() + name.substring( 1 ), value: codes[i] } );
      }
      var text = String( box.text );
      var all = [ box.firstButton, box.secondButton, box.thirdButton ];
      var preset = box.defaultButton >= 0 && box.defaultButton < 3 ? codes.indexOf( all[box.defaultButton] ) : -1;
      var escape = escapeOf( box, codes );
      for ( ;; )
      {
         var asked = { kind: "message", text: plain( text, 4 * MAX_TEXT ), buttons: names };
         if ( box.caption )
            asked.caption = line( box.caption, MAX_TEXT );
         if ( box.icon > 0 && box.icon < ICONS.length )
            asked.icon = ICONS[box.icon];
         var chosen = prompt( asked, box.caption ? String( box.caption ) : "PixInsight", text, choices, preset );
         if ( chosen !== null && chosen.answered )
         {
            var code = BUTTONS.indexOf( String( chosen.value ).toLowerCase() );
            if ( codes.indexOf( code ) < 0 )
               return undefined;
            note( "answered \"" + plain( text, 120 ) + "\" with " + BUTTONS[code] );
            return code;
         }
         if ( chosen !== null )
            return chosen.value;
         // Closed without a choice. Where no button stands for that, the question is asked again.
         if ( escape !== 0 )
            return escape;
      }
   }

   // Whatever goes wrong in here, the script gets its answer: from PixInsight's own window then.
   function answerOr( box, native )
   {
      var code;
      try
      {
         code = awaited() ? askMessage( box ) : undefined;
      }
      catch ( error )
      {
         code = undefined;
      }
      return code === undefined ? native() : code;
   }

   // ------------------------------------------------------------------------------------------
   // Getting hold of the dialogs
   // ------------------------------------------------------------------------------------------

   if ( v8 )
   {
      // What the script makes of these is noted, so that a field is found wherever it lies and
      // whatever the script keeps it in. This list holds on to nothing: what is in it goes when
      // its dialog does, unless it was described, which gives it a name for as long as the script runs.
      var noted = function( name )
      {
         var Native = root[name];
         if ( typeof Native !== "function" )
            return;
         root[name] = new Proxy( Native, {
            construct: function( target, args, newTarget )
            {
               var control = Reflect.construct( target, args, newTarget );
               if ( made.length >= MAX_MADE )
               {
                  // What is gone goes first. Only if that frees nothing, the oldest.
                  var alive = [];
                  for ( var m = 0; m < made.length; m++ )
                     if ( made[m].deref() !== undefined )
                        alive.push( made[m] );
                  made = alive.length < MAX_MADE ? alive : alive.slice( MAX_MADE / 4 );
               }
               made.push( new WeakRef( control ) );
               return control;
            }
         } );
      };
      for ( var k = 0; k < KINDS.length; k++ )
         noted( KINDS[k] );

      var known = [];
      root.Dialog = new Proxy( NativeDialog, {
         construct: function( target, args, newTarget )
         {
            var dialog = Reflect.construct( target, args, newTarget );
            if ( isControl( dialog ) && known.indexOf( dialog ) < 0 )
            {
               known.push( dialog );
               serve( dialog );
            }
            return dialog;
         }
      } );

      // Stands for an object of PixInsight whose own method cannot be replaced: everything goes
      // to that object, except what is answered here.
      var standIn = function( native, answers )
      {
         return new Proxy( {}, {
            get: function( target, name )
            {
               var answer = answers( name );
               if ( answer !== undefined )
                  return answer;
               var value = native[name];
               return typeof value === "function" ? value.bind( native ) : value;
            },
            set: function( target, name, value )
            {
               native[name] = value;
               return true;
            },
            has: function( target, name )
            {
               return name in native;
            }
         } );
      };

      // Without leave to work the dialogs, PixInsight's own windows stay what they are.
      if ( operate )
      {
         var NativeMessageBox = MessageBox;
         root.MessageBox = new Proxy( NativeMessageBox, {
            construct: function( target, args, newTarget )
            {
               var box = Reflect.construct( target, args, newTarget );
               var result;
               return standIn( box, function( name )
               {
                  if ( name === "execute" )
                     return function()
                     {
                        result = answerOr( box, function() { return box.execute(); } );
                        return result;
                     };
                  return name === "result" ? result : undefined;
               } );
            }
         } );

         var chooser = function( Native, kind )
         {
            return new Proxy( Native, {
               construct: function( target, args, newTarget )
               {
                  var native = Reflect.construct( target, args, newTarget );
                  var picked = null;
                  var ask = function()
                  {
                     var caption = native.caption ? String( native.caption ) : kind === "directory" ? "Select a folder" : kind === "save_file" ? "Save a file" : "Open a file";
                     var asked = { kind: kind, caption: line( caption, MAX_TEXT ) };
                     if ( kind === "open_file" && native.multipleSelections === true )
                        asked.multiple = true;
                     if ( native.initialPath )
                        asked.initialPath = String( native.initialPath );
                     var chosen = prompt( asked, caption, "The script asks for " + ( kind === "directory" ? "a folder" : kind === "save_file" ? "a file to write" : asked.multiple ? "files to open" : "a file to open" ) + ".",
                        [ { label: "Browse…", value: "browse" }, { label: "Cancel", value: "cancel" } ], 0 );
                     if ( chosen === null || chosen.value === false || ( !chosen.answered && chosen.value === "cancel" ) )
                     {
                        if ( chosen !== null && chosen.answered )
                           note( "cancelled \"" + line( caption, 120 ) + "\"" );
                        return false;
                     }
                     if ( !chosen.answered )
                        return native.execute();
                     picked = chosen.value instanceof Array ? chosen.value.map( String ) : [ String( chosen.value ) ];
                     note( "answered \"" + line( caption, 120 ) + "\" with " + picked.join( ", " ) );
                     return true;
                  };
                  return standIn( native, function( name )
                  {
                     if ( name === "execute" )
                        return function()
                        {
                           picked = null;
                           if ( !awaited() )
                              return native.execute();
                           try
                           {
                              return ask();
                           }
                           catch ( error )
                           {
                              picked = null;
                              return native.execute();
                           }
                        };
                     if ( picked === null )
                        return undefined;
                     if ( name === "fileName" || name === "filePath" || name === "directory" || name === "directoryPath" )
                        return picked[0];
                     if ( name === "fileNames" || name === "filePaths" )
                        return picked.slice();
                     if ( name === "selectedFileExtension" )
                        return File.extractExtension( picked[0] );
                     return undefined;
                  } );
               }
            } );
         };
         root.OpenFileDialog = chooser( OpenFileDialog, "open_file" );
         root.SaveFileDialog = chooser( SaveFileDialog, "save_file" );
         root.GetDirectoryDialog = chooser( GetDirectoryDialog, "directory" );
      }
   }
   else
   {
      // Left behind by a job whose clean-up never ran.
      if ( typeof root.__mcpUnhookDialogs === "function" )
         root.__mcpUnhookDialogs();
      nativeExecute = Dialog.prototype.execute;
      var nativeAsk = MessageBox.prototype.execute;
      var nativeAdd = Sizer.prototype.add;
      var nativeInsert = Sizer.prototype.insert;
      var nativeAddPage = TabBox.prototype.addPage;
      var unhook = function()
      {
         Dialog.prototype.execute = nativeExecute;
         MessageBox.prototype.execute = nativeAsk;
         Sizer.prototype.add = nativeAdd;
         Sizer.prototype.insert = nativeInsert;
         TabBox.prototype.addPage = nativeAddPage;
         for ( var i = 0; i < timers.length; i++ )
            timers[i].stop();
         timers = [];
         delete root.__mcpUnhookDialogs;
      };
      root.__mcpUnhookDialogs = unhook;
      // What a script lays out is noted, so that a field is found wherever the script keeps it.
      // This engine does not survive a replaced constructor, but a method can be replaced.
      var laidOut = function( native, at )
      {
         return function()
         {
            // Left behind by a job that nobody waits for any more: PixInsight's own method again.
            if ( !awaited() )
            {
               unhook();
               return native.apply( this, arguments );
            }
            var control = arguments.length > at ? arguments[at] : null;
            if ( isControl( control ) && made.indexOf( control ) < 0 )
            {
               if ( made.length >= MAX_MADE )
               {
                  // What belongs to a dialog that was open and is closed goes first. Only if that frees nothing, the oldest.
                  var kept = [];
                  for ( var m = 0; m < made.length; m++ )
                  {
                     var owner = ownerOf( made[m] );
                     if ( owner === null || named.indexOf( owner ) < 0 || open.indexOf( owner ) >= 0 )
                        kept.push( made[m] );
                  }
                  made = kept.length < MAX_MADE ? kept : kept.slice( MAX_MADE / 4 );
               }
               made.push( control );
            }
            return native.apply( this, arguments );
         };
      };
      Sizer.prototype.add = laidOut( nativeAdd, 0 );
      Sizer.prototype.insert = laidOut( nativeInsert, 1 );
      TabBox.prototype.addPage = laidOut( nativeAddPage, 0 );
      Dialog.prototype.execute = function()
      {
         if ( !awaited() )
         {
            unhook();
            return nativeExecute.apply( this, arguments );
         }
         noteOpen( this );
         // On this engine a timer that still runs when the script ends breaks the scripts after it.
         var timer = serve( this );
         try
         {
            return nativeExecute.apply( this, arguments );
         }
         finally
         {
            forget( timer );
            noteClosed( this );
            noteState();
         }
      };
      if ( operate )
         MessageBox.prototype.execute = function()
         {
            var box = this;
            var given = arguments;
            if ( !awaited() )
            {
               unhook();
               return nativeAsk.apply( box, given );
            }
            return answerOr( box, function() { return nativeAsk.apply( box, given ); } );
         };
   }
}
