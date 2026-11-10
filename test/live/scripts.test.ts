import { existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProcessCli } from '../../src/bridge/cli.js';
import { ManagedInstance } from '../../src/bridge/instance.js';
import type { JobSnapshot } from '../../src/bridge/jobs.js';
import type { Config } from '../../src/config.js';
import { wrapperFor, type Field } from '../../src/scripts/dialogs.js';
import { prepareHome } from '../../src/home.js';
import { scriptBlockReason } from '../../src/policy.js';
import { Session, type DialogAction, type ScriptView } from '../../src/session.js';
import { EXECUTABLE, PREPROCESS_SLOT, removeFilesOfSlots, removeSwapFilesSince, run, slotsOf, startLiveSession, WORKER_SLOT, type LiveSession } from './harness.js';

type Stats = { channels: Array<{ median: number }> };
type Report = {
  newViews: string[];
  closedViews: string[];
  changedViews: Array<{ view: string; changed: string[]; historyIndex: number; steps: number; note?: string }>;
  script?: string;
  startedOn?: string | null;
  activeAfter?: string | null;
  value?: unknown;
};

/** A script of the user as it is when the server starts. */
const CHANGING = '#feature-id McpLiveChanging : Utilities > McpLiveChanging\nconsole.writeln( "MCPLIVE as the user left it" );\n';

/**
 * A dialog with one of every kind of field, as a script of either engine writes it. Its handlers
 * note what PixInsight tells them, with PixInsight's own names for buttons, so that a test sees
 * what the script saw.
 */
const FORM_BODY = `
   var self = this;
   this.events = [];
   this.windowTitle = "MCP live form";

   this.name_Label = new Label( this );
   this.name_Label.useRichText = true;
   this.name_Label.text = "<b>Name</b> of the target:";
   this.name_Edit = new Edit( this );
   this.name_Edit.text = "initial";
   this.name_Edit.toolTip = "<p>The name of the thing.</p>";
   this.name_Edit.onEditCompleted = function() { self.events.push( "edit:" + self.name_Edit.text ); };

   this.key_Edit = new Edit( this );
   this.key_Edit.passwordMode = true;
   this.key_Edit.text = "MCPLIVE-SECRET";

   this.flag_CheckBox = new CheckBox( this );
   this.flag_CheckBox.text = "Use the flag";
   this.flag_CheckBox.onCheck = function( checked ) { self.events.push( "check:" + checked ); self.locked_Edit.enabled = checked; };

   this.locked_Edit = new Edit( this );
   this.locked_Edit.text = "only with the flag";
   this.locked_Edit.enabled = false;
   this.locked_Edit.onEditCompleted = function() { self.events.push( "locked:" + self.locked_Edit.text ); };

   this.mode_ComboBox = new ComboBox( this );
   this.mode_ComboBox.addItem( "First" );
   this.mode_ComboBox.addItem( "Second" );
   this.mode_ComboBox.addItem( "Third" );
   this.mode_ComboBox.onItemSelected = function( index ) { self.events.push( "combo:" + index ); };

   this.amount_NumericControl = new NumericControl( this );
   this.amount_NumericControl.label.text = "Amount:";
   this.amount_NumericControl.setRange( 0, 1 );
   this.amount_NumericControl.slider.setRange( 0, 100 );
   this.amount_NumericControl.setPrecision( 2 );
   this.amount_NumericControl.setValue( 0.25 );
   this.amount_NumericControl.onValueUpdated = function( value ) { self.events.push( "amount:" + value ); };

   this.count_SpinBox = new SpinBox( this );
   this.count_SpinBox.minValue = 1;
   this.count_SpinBox.maxValue = 10;
   this.count_SpinBox.value = 3;
   this.count_SpinBox.onValueUpdated = function( value ) { self.events.push( "count:" + value ); };

   this.results_TreeBox = new TreeBox( this );
   this.results_TreeBox.numberOfColumns = 2;
   this.results_TreeBox.setHeaderText( 0, "What" );
   this.results_TreeBox.setHeaderText( 1, "Value" );
   this.results_TreeBox.setFixedHeight( 70 );
   // A table tells its script of a current row as soon as it has rows, so only a row that was chosen counts.
   this.results_TreeBox.onCurrentNodeUpdated = function( node ) { if ( node && self.results_TreeBox.childIndex( node ) > 0 ) self.events.push( "row:" + node.text( 0 ) ); };

   this.canvas_Control = new Control( this );
   this.canvas_Control.setFixedSize( 120, 40 );
   this.canvas_Control.onPaint = function()
   {
      var g = new Graphics( self.canvas_Control );
      g.fillRect( self.canvas_Control.boundsRect, new Brush( 0xff204060 ) );
      g.end();
   };
   this.canvas_Control.onMousePress = function( x, y, button ) { self.events.push( "mouse:" + x + "," + y + "," + ( button == MouseButton_Left ? "left" : button ) ); };

   // Not kept on the dialog, as in a script whose names say nothing.
   var unnamed = new CheckBox( this );
   unnamed.text = "Not a property";
   unnamed.onCheck = function( checked ) { self.events.push( "unnamed:" + checked ); };

   function button( text, onClick )
   {
      var made = new PushButton( self );
      made.text = text;
      made.onClick = onClick;
      return made;
   }
   function buttonName( code )
   {
      return code == StdButton_Yes ? "yes" : code == StdButton_No ? "no" : code == StdButton_Cancel ? "cancel" : code == StdButton_Ok ? "ok" : "code " + code;
   }
   this.measure_Button = button( "Measure", function()
   {
      self.results_TreeBox.clear();
      var rows = [ [ "Median", ( self.amount_NumericControl.value * 100 ).toFixed( 1 ) ], [ "Count", "" + self.count_SpinBox.value ], [ "Name", self.name_Edit.text ] ];
      for ( var i = 0; i < rows.length; i++ )
      {
         var node = new TreeBoxNode( self.results_TreeBox );
         node.setText( 0, rows[i][0] );
         node.setText( 1, rows[i][1] );
      }
      self.events.push( "measure" );
   } );
   this.ask_Button = button( "Ask", function()
   {
      var box = new MessageBox( "<p>Replace the <b>file</b>?</p>", "MCP live question", StdIcon_Question, StdButton_Yes, StdButton_No );
      self.events.push( "ask:" + buttonName( box.execute() ) );
   } );
   this.pick_Button = button( "Pick", function()
   {
      var chooser = new OpenFileDialog;
      chooser.caption = "Pick a file for the test";
      chooser.loadImageFilters();
      self.events.push( chooser.execute() ? "file:" + chooser.fileName : "file:none" );
   } );
   this.child_Button = button( "Child", function()
   {
      var child = new ChildDialog;
      var code = child.execute();
      self.events.push( "child:" + ( code == StdDialogCode_Ok ? "ok" : "cancel" ) + ":" + child.value_Edit.text );
   } );
   this.fail_Button = button( "Fail", function() { self.events.push( "fail" ); throw new Error( "MCPLIVE the handler failed" ); } );
   this.ok_Button = button( "OK", function() { self.ok(); } );
   this.cancel_Button = button( "Cancel", function() { self.cancel(); } );

   var buttons = new HorizontalSizer;
   buttons.spacing = 6;
   buttons.add( this.measure_Button );
   buttons.add( this.ask_Button );
   buttons.add( this.pick_Button );
   buttons.add( this.child_Button );
   buttons.add( this.fail_Button );
   buttons.addStretch();
   buttons.add( this.ok_Button );
   buttons.add( this.cancel_Button );

   this.sizer = new VerticalSizer;
   this.sizer.margin = 8;
   this.sizer.spacing = 6;
   this.sizer.add( this.name_Label );
   this.sizer.add( this.name_Edit );
   this.sizer.add( this.key_Edit );
   this.sizer.add( this.flag_CheckBox );
   this.sizer.add( this.locked_Edit );
   this.sizer.add( this.mode_ComboBox );
   this.sizer.add( this.amount_NumericControl );
   this.sizer.add( this.count_SpinBox );
   this.sizer.add( this.results_TreeBox );
   this.sizer.add( this.canvas_Control );
   this.sizer.add( unnamed );
   this.sizer.add( buttons );
`;
const CHILD_BODY = `
   var self = this;
   this.windowTitle = "MCP live child";
   this.value_Edit = new Edit( this );
   this.value_Edit.text = "child value";
   this.ok_Button = new PushButton( this );
   this.ok_Button.text = "OK";
   this.ok_Button.onClick = function() { self.ok(); };
   this.sizer = new VerticalSizer;
   this.sizer.margin = 8;
   this.sizer.add( this.value_Edit );
   this.sizer.add( this.ok_Button );
`;
/** Two lines, because the server cuts a long line of a log. */
const FORM_END = `
var dialog = new FormDialog;
var code = dialog.execute();
console.writeln( "MCPLIVE values " + JSON.stringify( { code: code, name: dialog.name_Edit.text, flag: dialog.flag_CheckBox.checked, mode: dialog.mode_ComboBox.currentItem, amount: dialog.amount_NumericControl.value, count: dialog.count_SpinBox.value } ) );
console.writeln( "MCPLIVE events " + dialog.events.join( " | " ) );
`;
const CONSTANTS = '#include <pjsr/StdIcon.jsh>\n#include <pjsr/StdButton.jsh>\n#include <pjsr/StdDialogCode.jsh>\n#include <pjsr/ButtonCodes.jsh>\n';
/** As most scripts of the Script menu are written, for the older engine. */
const CLASSIC_FORM = `#feature-id McpLiveForm : Utilities > McpLiveForm
#include <pjsr/Sizer.jsh>
#include <pjsr/NumericControl.jsh>
${CONSTANTS}
function ChildDialog()
{
   this.__base__ = Dialog;
   this.__base__();
${CHILD_BODY}}
ChildDialog.prototype = new Dialog;

function FormDialog()
{
   this.__base__ = Dialog;
   this.__base__();
${FORM_BODY}}
FormDialog.prototype = new Dialog;
${FORM_END}`;
const V8_FORM = `#engine v8
#feature-id McpLiveFormV8 : Utilities > McpLiveFormV8
${CONSTANTS}
class ChildDialog extends Dialog
{
   constructor()
   {
      super();
${CHILD_BODY}   }
}

class FormDialog extends Dialog
{
   constructor()
   {
      super();
${FORM_BODY}   }
}
${FORM_END}`;
/** The kinds of fields the first form does not have, with a field for a key that the script can be told to show. */
const KINDS_BODY = `
   var self = this;
   this.events = [];
   this.windowTitle = "MCP live kinds";

   this.tabs_TabBox = new TabBox( this );
   var first = new Control( this );
   var second = new Control( this );
   this.onFirst_Label = new Label( first );
   this.onFirst_Label.text = "On the first page";
   first.sizer = new Sizer( true );
   first.sizer.add( this.onFirst_Label );
   this.onSecond_CheckBox = new CheckBox( second );
   this.onSecond_CheckBox.text = "On the second page";
   this.onSecond_CheckBox.onCheck = function( checked ) { self.events.push( "second:" + checked ); };
   second.sizer = new Sizer( true );
   second.sizer.add( this.onSecond_CheckBox );
   this.tabs_TabBox.addPage( first, "Target" );
   this.tabs_TabBox.addPage( second, "Output" );
   this.tabs_TabBox.onPageSelected = function( index ) { self.events.push( "page:" + index ); };

   this.reject_GroupBox = new GroupBox( this );
   this.reject_GroupBox.title = "Reject outliers";
   this.reject_GroupBox.titleCheckBox = true;
   this.reject_GroupBox.checked = false;
   this.reject_GroupBox.onCheck = function( checked ) { self.events.push( "group:" + checked ); };
   this.inGroup_Label = new Label( this.reject_GroupBox );
   this.inGroup_Label.text = "Inside the group";
   this.reject_GroupBox.sizer = new Sizer( true );
   this.reject_GroupBox.sizer.margin = 6;
   this.reject_GroupBox.sizer.add( this.inGroup_Label );

   this.level_Slider = new Slider( this );
   this.level_Slider.setRange( 0, 10 );
   this.level_Slider.onValueUpdated = function( value ) { self.events.push( "slider:" + value ); };

   this.mean_RadioButton = new RadioButton( this );
   this.mean_RadioButton.text = "Mean";
   this.mean_RadioButton.checked = true;
   this.median_RadioButton = new RadioButton( this );
   this.median_RadioButton.text = "Median";
   this.median_RadioButton.onCheck = function( checked ) { self.events.push( "median:" + checked ); };

   this.pin_ToolButton = new ToolButton( this );
   this.pin_ToolButton.text = "Pin";
   this.pin_ToolButton.checkable = true;
   this.pin_ToolButton.onCheck = function( checked ) { self.events.push( "pin:" + checked ); };

   this.notes_TextBox = new TextBox( this );
   this.notes_TextBox.text = "Notes of the script";
   this.notes_TextBox.readOnly = true;
   this.notes_TextBox.setFixedHeight( 40 );

   this.fixed_Edit = new Edit( this );
   this.fixed_Edit.text = "<computed>";
   this.fixed_Edit.readOnly = true;

   this.scale_ComboBox = new ComboBox( this );
   this.scale_ComboBox.addItem( "1" );
   this.scale_ComboBox.addItem( "2" );
   this.scale_ComboBox.addItem( "4" );
   this.scale_ComboBox.addItem( "<Auto>" );
   this.scale_ComboBox.onItemSelected = function( index ) { self.events.push( "scale:" + index ); };

   this.free_ComboBox = new ComboBox( this );
   this.free_ComboBox.editEnabled = true;
   this.free_ComboBox.addItem( "red" );
   this.free_ComboBox.editText = "red";
   this.free_ComboBox.onEditTextUpdated = function( text ) { self.events.push( "free:" + self.free_ComboBox.editText ); };

   this.views_ViewList = new ViewList( this );
   this.views_ViewList.getAll();
   this.views_ViewList.onViewSelected = function( view ) { self.events.push( "view:" + view.id ); };

   this.precise_NumericEdit = new NumericEdit( this );
   this.precise_NumericEdit.label.text = "Precise:";
   this.precise_NumericEdit.setRange( 0, 1 );
   this.precise_NumericEdit.setPrecision( 3 );
   this.precise_NumericEdit.setValue( 0.125 );
   this.precise_NumericEdit.onValueUpdated = function( value ) { self.events.push( "precise:" + value ); };

   this.key_Edit = new Edit( this );
   this.key_Edit.passwordMode = true;
   this.key_Edit.text = "MCPLIVE-KEY";
   this.show_CheckBox = new CheckBox( this );
   this.show_CheckBox.text = "Show the key";
   this.show_CheckBox.onCheck = function( checked ) { self.key_Edit.passwordMode = !checked; };

   this.ok_Button = new PushButton( this );
   this.ok_Button.text = "OK";
   this.ok_Button.onClick = function() { self.ok(); };

   var radios = new Sizer( false );
   radios.spacing = 6;
   radios.add( this.mean_RadioButton );
   radios.add( this.median_RadioButton );
   radios.add( this.pin_ToolButton );
   radios.addStretch();
   this.sizer = new Sizer( true );
   this.sizer.margin = 8;
   this.sizer.spacing = 6;
   var all = [ this.tabs_TabBox, this.reject_GroupBox, this.level_Slider, radios, this.notes_TextBox, this.fixed_Edit, this.scale_ComboBox, this.free_ComboBox,
      this.views_ViewList, this.precise_NumericEdit, this.key_Edit, this.show_CheckBox ];
   for ( var i = 0; i < all.length; i++ )
      this.sizer.add( all[i] );
`;
/** What only a script for V8 can be asked through the server: files and folders. And a dialog that was made before the one that opens it. */
const KINDS_V8_EXTRAS = `
   var settings = new Dialog;
   settings.windowTitle = "MCP live settings";
   settings.depth_Edit = new Edit( settings );
   settings.depth_Edit.text = "made before the dialog that opens it";
   settings.sizer = new Sizer( true );
   settings.sizer.add( settings.depth_Edit );
   function button( text, onClick )
   {
      var made = new PushButton( self );
      made.text = text;
      made.onClick = onClick;
      self.sizer.add( made );
   }
   button( "Save", function()
   {
      var chooser = new SaveFileDialog;
      chooser.caption = "Save the result of the test";
      self.events.push( chooser.execute() ? "save:" + chooser.fileName : "save:none" );
   } );
   button( "Folder", function()
   {
      var chooser = new GetDirectoryDialog;
      chooser.caption = "Pick a folder for the test";
      self.events.push( chooser.execute() ? "folder:" + chooser.directory : "folder:none" );
   } );
   button( "Several", function()
   {
      var chooser = new OpenFileDialog;
      chooser.caption = "Pick files for the test";
      chooser.multipleSelections = true;
      self.events.push( chooser.execute() ? "several:" + chooser.fileNames.join( "+" ) : "several:none" );
   } );
   button( "Settings", function() { self.events.push( "settings:" + settings.execute() ); } );
`;
const KINDS_END = `
var dialog = new KindsDialog;
var code = dialog.execute();
// One line each, because these hold whole paths, and the server cuts a long line of a log.
for ( var i = 0; i < dialog.events.length; i++ )
   console.writeln( "MCPLIVE event " + dialog.events[i] );
`;
const CLASSIC_KINDS = `#feature-id McpLiveKinds : Utilities > McpLiveKinds
#include <pjsr/NumericControl.jsh>

function KindsDialog()
{
   this.__base__ = Dialog;
   this.__base__();
${KINDS_BODY}   this.sizer.add( this.ok_Button );
}
KindsDialog.prototype = new Dialog;
${KINDS_END}`;
// With the directive in capitals, as one script that PixInsight ships has it.
const V8_KINDS = `#engine V8
#feature-id McpLiveKindsV8 : Utilities > McpLiveKindsV8

class KindsDialog extends Dialog
{
   constructor()
   {
      super();
${KINDS_BODY}${KINDS_V8_EXTRAS}      this.sizer.add( this.ok_Button );
   }
}
${KINDS_END}`;
/**
 * Tables as WBPP has them: on an object of the script and not on the dialog, two of them in one
 * place that are shown in turns, and rows inside rows. And a text that is longer than a dialog shows.
 */
const TABLES_BODY = `
   var self = this;
   this.events = [];
   this.windowTitle = "MCP live tables";

   function cells( node, texts )
   {
      for ( var c = 0; c < texts.length; c++ )
         node.setText( c, texts[c] );
      return node;
   }
   function headers( table, texts )
   {
      table.numberOfColumns = texts.length;
      for ( var c = 0; c < texts.length; c++ )
         table.setHeaderText( c, texts[c] );
      table.setScaledMinSize( 360, 90 );
   }

   this.keeper = { groups: [ new TreeBox( this ), new TreeBox( this ) ] };
   for ( var t = 0; t < 2; t++ )
   {
      var groups = this.keeper.groups[t];
      headers( groups, [ "#", "LIGHT", "Filter", "" ] );
      cells( new TreeBoxNode( groups ), [ "1", "10 frames", "H" ] );
      cells( new TreeBoxNode( groups ), [ "2", "42 frames", "L" ] );
      groups.onCurrentNodeUpdated = function( node ) { if ( node ) self.events.push( "group:" + node.text( 1 ) ); };
   }
   this.keeper.groups[1].hide();
   this.redraw_Button = new PushButton( this );
   this.redraw_Button.text = "Redraw";
   this.redraw_Button.onClick = function()
   {
      var on = self.keeper.groups[0].visible ? 0 : 1;
      self.keeper.groups[on].hide();
      self.keeper.groups[1 - on].show();
   };

   this.files_TreeBox = new TreeBox( this );
   headers( this.files_TreeBox, [ "Light frames", "Time", "Internal" ] );
   this.files_TreeBox.hideColumn( 2 );
   var bin = cells( new TreeBoxNode( this.files_TreeBox ), [ "Binning 1" ] );
   var h = cells( new TreeBoxNode( bin ), [ "H" ] );
   var first = cells( new TreeBoxNode( h ), [ "SESSION: 1 (2 frames)" ] );
   cells( new TreeBoxNode( first ), [ "a.fits", "21:00", "x" ] );
   cells( new TreeBoxNode( first ), [ "b.fits", "21:05", "x" ] );
   cells( new TreeBoxNode( cells( new TreeBoxNode( h ), [ "SESSION: 2 (1 frame)" ] ) ), [ "c.fits", "22:00", "x" ] );
   var o = cells( new TreeBoxNode( bin ), [ "O" ] );
   var many = cells( new TreeBoxNode( o ), [ "SESSION: 1 (70 frames)" ] );
   for ( var i = 0; i < 70; i++ )
      cells( new TreeBoxNode( many ), [ "o" + i + ".fits", "23:00", "x" ] );
   this.nodes = [ bin, h, first, o ];
   this.files_TreeBox.onCurrentNodeUpdated = function( node ) { if ( node ) self.events.push( "file:" + node.text( 0 ) ); };

   this.gear_ToolButton = new ToolButton( this );
   this.gear_ToolButton.toolTip = "<p>Settings of the <b>registration</b>.</p>";
   this.gear_ToolButton.onClick = function() { self.events.push( "gear" ); };

   var digits = "";
   for ( var d = 0; d < 2500; d++ )
      digits += "0123456789";
   this.report_TextBox = new TextBox( this );
   this.report_TextBox.readOnly = true;
   this.report_TextBox.text = digits;

   // Work that takes a while, as a run does: its button is there from the start, and can be pressed once the work
   // is over. The work is over when a file is there, which the test writes.
   this.work_Button = new PushButton( this );
   this.work_Button.text = "Work";
   this.finished_Button = new PushButton( this );
   this.finished_Button.text = "Finished";
   this.finished_Button.enabled = false;
   this.work_Timer = new Timer;
   this.work_Timer.interval = 0.25;
   this.work_Timer.periodic = true;
   this.work_Timer.onTimeout = function()
   {
      if ( !File.exists( "@@WORK_DONE@@" ) )
         return;
      self.work_Timer.stop();
      self.finished_Button.enabled = true;
      self.events.push( "worked" );
   };
   this.work_Button.onClick = function() { self.work_Timer.start(); };
   this.finished_Button.onClick = function() { self.events.push( "finished" ); };

   // A preview as scripts have it: drawn on the area of a scroll box, which the script keeps nowhere.
   var scroll = new ScrollBox( this );
   scroll.setScaledMinSize( 160, 60 );
   scroll.viewport.onPaint = function() {};
   scroll.viewport.onMousePress = function( x, y, button ) { self.events.push( "preview:" + button ); };

   this.ok_Button = new PushButton( this );
   this.ok_Button.text = "OK";
   this.ok_Button.onClick = function() { self.work_Timer.stop(); self.ok(); };

   this.sizer = new Sizer( true );
   this.sizer.margin = 8;
   this.sizer.spacing = 6;
   var all = [ this.keeper.groups[0], this.keeper.groups[1], this.redraw_Button, this.files_TreeBox, this.gear_ToolButton, this.report_TextBox, this.work_Button, this.finished_Button, scroll ];
   for ( var a = 0; a < all.length; a++ )
      this.sizer.add( all[a] );
`;
/** What only V8 lets the server see: a table the script keeps nowhere, and one of a class of the script. */
const TABLES_V8_EXTRAS = `
      let unkept = new TreeBox( this );
      unkept.numberOfColumns = 1;
      unkept.setHeaderText( 0, "Kept nowhere" );
      this.sizer.add( unkept );
      class OwnTable extends TreeBox
      {
         constructor( parent )
         {
            super( parent );
            this.numberOfColumns = 1;
            this.setHeaderText( 0, "Of a class of the script" );
         }
      }
      let own = new OwnTable( this );
      this.sizer.add( own );
      this.events.push( "own:" + ( own instanceof TreeBox ) + ":" + ( own instanceof OwnTable ) + ":" + ( unkept instanceof Control ) );
`;
const TABLES_END = `
var dialog = new TablesDialog;
var code = dialog.execute();
// On the older engine a timer that still runs when a script ends breaks the scripts after it.
dialog.work_Timer.stop();
for ( var i = 0; i < dialog.events.length; i++ )
   console.writeln( "MCPLIVE event " + dialog.events[i] );
var open = [];
for ( var n = 0; n < dialog.nodes.length; n++ )
   open.push( dialog.nodes[n].expanded );
console.writeln( "MCPLIVE expanded " + open.join( " " ) );
`;
const CLASSIC_TABLES = `#feature-id McpLiveTables : Utilities > McpLiveTables

function TablesDialog()
{
   this.__base__ = Dialog;
   this.__base__();
${TABLES_BODY}   this.sizer.add( this.ok_Button );
}
TablesDialog.prototype = new Dialog;
${TABLES_END}`;
const V8_TABLES = `#engine v8
#feature-id McpLiveTablesV8 : Utilities > McpLiveTablesV8

class TablesDialog extends Dialog
{
   constructor()
   {
      super();
${TABLES_BODY}${TABLES_V8_EXTRAS}      this.sizer.add( this.ok_Button );
   }
}
${TABLES_END}`;
/** Shows the same dialog again after it was accepted, as a script that works in rounds does. */
const LOOP = `
var dialog = new Dialog;
dialog.windowTitle = "MCP live round";
dialog.round_Label = new Label( dialog );
dialog.again_Button = new PushButton( dialog );
dialog.again_Button.text = "Again";
dialog.again_Button.onClick = function() { dialog.ok(); };
dialog.sizer = new Sizer( true );
dialog.sizer.add( dialog.round_Label );
dialog.sizer.add( dialog.again_Button );
var rounds = 0;
do
   dialog.round_Label.text = "Round " + ( rounds + 1 );
while ( dialog.execute() && ++rounds < 3 );
console.writeln( "MCPLIVE rounds " + rounds );
`;

/** Says whether PixInsight's own methods are in place on the older engine, which keeps its scope between scripts. */
const NATIVE_STATE =
  '"execute=" + ( String( Dialog.prototype.execute ).indexOf( "[native code]" ) >= 0 ) + " ask=" + ( String( MessageBox.prototype.execute ).indexOf( "[native code]" ) >= 0 )' +
  ' + " layout=" + ( String( Sizer.prototype.add ).indexOf( "[native code]" ) >= 0 && String( Sizer.prototype.insert ).indexOf( "[native code]" ) >= 0 && String( TabBox.prototype.addPage ).indexOf( "[native code]" ) >= 0 )' +
  ' + " hook=" + ( typeof __mcpUnhookDialogs )';

const median = async (session: Session, view: string) => (await run<Stats>(session, 'image_stats', { view })).channels[0]!.median;

// Stands in for the PixInsight a user sits at. Its slot is always set explicitly, because otherwise
// these tests would attach to whatever PixInsight the developer has open.
const USER_SLOT = WORKER_SLOT + 5;
const SHADOW_SLOT = WORKER_SLOT + 6;

describe.skipIf(!existsSync(EXECUTABLE))('scripts of the Script menu, in shared mode', { timeout: 120_000 }, () => {
  const startedAt = Date.now();
  let home: string;
  let userHome: string;
  let scriptsDir: string;
  let session: Session;
  let user: ManagedInstance;

  const config = (): Config => ({
    executable: EXECUTABLE,
    mode: 'shared',
    slot: USER_SLOT,
    workerSlot: WORKER_SLOT,
    shadowSlot: SHADOW_SLOT,
    preprocessSlot: PREPROCESS_SLOT,
    headless: true,
    home,
    allowedPrograms: [],
    guideDirs: [],
    scriptDirs: [scriptsDir],
    allowCode: false,
    scriptDialogs: 'operate',
  });

  const newImage = async (id: string, level: number) => {
    const created = await session.jobs.wait(
      session.runProcess({ processId: 'NewImage', global: true, params: { id, width: 64, height: 32, numberOfChannels: 3, colorSpace: 'RGB', v0: level, v1: level, v2: level } }).id,
      30_000,
    );
    expect(created.state).toBe('succeeded');
  };

  const start = (script: string, view?: string, timeoutMs = 60_000): Promise<JobSnapshot> => session.jobs.wait(session.startScript({ script, view }).id, timeoutMs);

  beforeAll(async () => {
    // With letters outside ASCII and a space: the file a script is started through holds these paths.
    home = await mkdtemp(join(tmpdir(), 'pixinsight-mcp skrípts-'));
    userHome = await mkdtemp(join(tmpdir(), 'pixinsight-mcp-user-'));
    scriptsDir = join(home, 'my scrípts');
    await mkdir(scriptsDir, { recursive: true });

    // In the classic engine, like nearly every script of the Script menu.
    await writeFile(
      join(scriptsDir, 'McpLiveStep.js'),
      `#feature-id    McpLiveStep : Utilities > McpLiveStep
#feature-info  Changes the active image in one step and makes a new one, \\
               for a <b>test</b>.
var w = ImageWindow.activeWindow;
console.writeln( "MCPLIVE active=" + w.mainView.id + " viewTarget=" + Parameters.isViewTarget + " globalTarget=" + Parameters.isGlobalTarget + " args=" + jsArguments.length );
var P = new PixelMath;
P.expression = "$T*0.5 + 0.1";
P.useSingleExpression = true;
P.createNewImage = false;
P.executeOn( w.mainView );
var made = new ImageWindow( 16, 8, 1, 32, true, false, "mcp_script_made" );
made.show();
`,
    );
    await writeFile(
      join(scriptsDir, 'McpLiveSilent.js'),
      `#engine v8
#feature-id McpLiveSilent : Utilities > McpLiveSilent
const view = ImageWindow.activeWindow.mainView;
view.beginProcess( UndoFlag.NoSwapFile );
view.image.fill( 0.75 );
view.endProcess();
`,
    );
    await writeFile(
      join(scriptsDir, 'McpLiveKeyword.js'),
      `#engine v8
#feature-id McpLiveKeyword : Utilities > McpLiveKeyword
const window = ImageWindow.activeWindow;
window.keywords = window.keywords.concat( [ new FITSKeyword( "MCPLIVE", "1", "from a test" ) ] );
`,
    );
    await writeFile(join(scriptsDir, 'McpLiveMount.js'), '#feature-id McpLiveMount : Instrumentation > McpLiveMount\nconsole.writeln( "MCPLIVE must not run" );\n');
    await writeFile(join(scriptsDir, 'McpLiveChanging.js'), CHANGING);
    await writeFile(
      join(scriptsDir, 'McpLiveRecursion.js'),
      `#feature-id McpLiveRecursion : Utilities > McpLiveRecursion
var P = new Script;
P.filePath = "${join(scriptsDir, 'McpLiveStep.js')}";
console.writeln( "MCPLIVE recursion=" + P.executeGlobal() );
`,
    );
    await writeFile(join(scriptsDir, 'McpLiveForm.js'), CLASSIC_FORM);
    await writeFile(join(scriptsDir, 'McpLiveFormV8.js'), V8_FORM);
    await writeFile(join(scriptsDir, 'McpLiveKinds.js'), CLASSIC_KINDS);
    await writeFile(join(scriptsDir, 'McpLiveKindsV8.js'), V8_KINDS);
    // The file whose presence ends the work of these scripts, by a path with letters outside ASCII and a space.
    const workDone = JSON.stringify(join(scriptsDir, 'work-done.txt'));
    await writeFile(join(scriptsDir, 'McpLiveTables.js'), CLASSIC_TABLES.replace('"@@WORK_DONE@@"', workDone));
    await writeFile(join(scriptsDir, 'McpLiveTablesV8.js'), V8_TABLES.replace('"@@WORK_DONE@@"', workDone));
    await writeFile(join(scriptsDir, 'McpLiveLoop.js'), `#feature-id McpLiveLoop : Utilities > McpLiveLoop\n${LOOP}`);
    await writeFile(join(scriptsDir, 'McpLiveLoopV8.js'), `#engine v8\n#feature-id McpLiveLoopV8 : Utilities > McpLiveLoopV8\n${LOOP}`);
    for (const [name, engine] of [
      ['McpLiveAsk', ''],
      ['McpLiveAskV8', '#engine v8\n'],
    ]) {
      await writeFile(
        join(scriptsDir, `${name}.js`),
        `${engine}#feature-id ${name} : Utilities > ${name}
${CONSTANTS}
var answer = ( new MessageBox( "No image is open. Go on?", "MCP live", StdIcon_Warning, StdButton_Yes, StdButton_No, StdButton_Cancel ) ).execute();
console.writeln( "MCPLIVE answered " + ( answer == StdButton_Cancel ? "cancel" : answer == StdButton_No ? "no" : answer ) );
`,
      );
    }
    // Says what it finds of PixInsight's own methods, and closes its dialog itself after a while.
    await writeFile(
      join(scriptsDir, 'McpLiveSelfClosing.js'),
      `#feature-id McpLiveSelfClosing : Utilities > McpLiveSelfClosing
#include <pjsr/Sizer.jsh>
var found = [ "before " + ${NATIVE_STATE} ];
var dialog = new Dialog;
dialog.windowTitle = "MCP live self closing";
dialog.note_Label = new Label( dialog );
dialog.note_Label.text = "Closes by itself";
dialog.sizer = new VerticalSizer;
dialog.sizer.add( dialog.note_Label );
var ticks = 0;
var timer = new Timer;
timer.interval = 0.25;
timer.periodic = true;
timer.onTimeout = function() { if ( ++ticks >= ( jsArguments.length > 1 ? 2 : 12 ) && dialog.visible ) dialog.ok(); };
timer.start();
try
{
   dialog.execute();
}
finally
{
   timer.stop();
}
found.push( "after " + ${NATIVE_STATE} );
console.writeln( "MCPLIVE self closing: " + found.join( "; " ) );
if ( jsArguments.length > 0 )
   File.writeTextFile( jsArguments[0], found.join( "; " ) );
`,
    );
    await writeFile(join(scriptsDir, 'McpLiveNative.js'), `#feature-id McpLiveNative : Utilities > McpLiveNative\nconsole.writeln( "MCPLIVE native " + ${NATIVE_STATE} );\n`);
    await writeFile(
      join(scriptsDir, 'McpLiveDialog.js'),
      `#feature-id McpLiveDialog : Utilities > McpLiveDialog
var dialog = new Dialog;
dialog.windowTitle = "MCP live test";
dialog.execute();
`,
    );

    const cli = new ProcessCli(EXECUTABLE, { headless: true, cwd: userHome });
    user = new ManagedInstance(cli, [USER_SLOT], await prepareHome(userHome));
    await user.resolve();
    session = await Session.create(config());
    await newImage('mcp_script_a', 0.4);
    // Made last, so this is the active image, and not the one the scripts are started on.
    await newImage('mcp_script_b', 0.6);
  }, 120_000);

  afterAll(async () => {
    await session?.close();
    await user?.stop();
    await rm(home, { recursive: true, force: true });
    await rm(userHome, { recursive: true, force: true });
    await removeFilesOfSlots([USER_SLOT, ...slotsOf(config())], startedAt);
    await removeSwapFilesSince(startedAt);
  });

  it('finds the scripts PixInsight ships where PixInsight says they are, and those in a folder of the user', async () => {
    const ping = await run<{ scriptsDir: string }>(session, 'ping');
    expect(existsSync(ping.scriptsDir)).toBe(true);

    const scripts = await session.scripts();
    expect(scripts.length).toBeGreaterThan(20);
    const solver = scripts.find((script) => script.name === 'ImageSolver');
    expect(solver?.path.startsWith(ping.scriptsDir)).toBe(true);
    expect(solver?.menus.length).toBeGreaterThan(0);
    expect(scripts.find((script) => script.name === 'McpLiveStep')).toEqual({
      name: 'McpLiveStep',
      menus: ['Utilities > McpLiveStep'],
      info: 'Changes the active image in one step and makes a new one, for a test.',
      path: join(scriptsDir, 'McpLiveStep.js'),
      source: 'user',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(solver?.source).toBe('shipped');

    // Two scripts that PixInsight ships carry one name, and differ in their menu item only.
    const twin = join(ping.scriptsDir, 'NoiseEvaluation', 'NoiseEvaluationCFA.js');
    if (existsSync(twin)) {
      expect(scripts.find((script) => script.path === twin)?.name).toBe('NoiseEvaluation (CFA Bayer)');
      expect(scripts.find((script) => script.name === 'NoiseEvaluation')?.path).toBe(join(ping.scriptsDir, 'NoiseEvaluation', 'NoiseEvaluation.js'));
    }
    expect(new Set(scripts.map((script) => script.name.toLowerCase())).size).toBe(scripts.length);
  });

  it('runs a script on the image it was started on, and reports what the script did and wrote', async () => {
    const before = await median(session, 'mcp_script_a');
    const done = await start('McpLiveStep', 'mcp_script_a');
    expect(done.state).toBe('succeeded');
    const report = done.value as Report;

    expect(report).toMatchObject({ script: 'McpLiveStep', startedOn: 'mcp_script_a', activeAfter: 'mcp_script_made', newViews: ['mcp_script_made'], closedViews: [] });
    expect(report.changedViews).toEqual([{ view: 'mcp_script_a', changed: ['history'], historyIndex: expect.any(Number), steps: 1 }]);
    // PixInsight gives a script from the command line its arguments, and no target to run on.
    expect(done.log).toContain('MCPLIVE active=mcp_script_a viewTarget=false globalTarget=false args=0');
    // Only what the script wrote, without what PixInsight notes about commands from outside.
    expect(done.log?.join('\n')).not.toMatch(/IPC execute command|Processing script file|^run -/m);

    // The real effect, on this image and not on the one that was active before.
    expect(await median(session, 'mcp_script_a')).toBeCloseTo(before * 0.5 + 0.1, 4);
    expect(await median(session, 'mcp_script_b')).toBeCloseTo(0.6, 4);
    // The step is in the history, so the assistant can take it back.
    await run(session, 'undo', { view: 'mcp_script_a', count: report.changedViews[0]!.steps, historyIndex: report.changedViews[0]!.historyIndex });
    expect(await median(session, 'mcp_script_a')).toBeCloseTo(before, 4);
  });

  it('runs a script that PixInsight ships, and keeps the note about its signature out of the log', async () => {
    const done = await start('NoiseEvaluation', 'mcp_script_a');
    expect(done.state).toBe('succeeded');
    expect(done.log?.length).toBeGreaterThan(0);
    expect(done.log?.join('\n')).not.toMatch(/Code signature verified|^developer-id|^script-id/m);
    expect((done.value as Report).changedViews).toEqual([]);
  });

  it('says so when a script changed pixels with no step in the history', async () => {
    const done = await start('McpLiveSilent', 'mcp_script_b');
    expect(done.state).toBe('succeeded');
    expect((done.value as Report).changedViews).toEqual([
      { view: 'mcp_script_b', changed: ['pixels'], historyIndex: expect.any(Number), steps: 0, note: expect.stringMatching(/no step in the history/) },
    ]);
    expect(await median(session, 'mcp_script_b')).toBeCloseTo(0.75, 4);
  });

  it('notices a script that only changed a value in the metadata, as solving an image again does', async () => {
    const done = await start('McpLiveKeyword', 'mcp_script_b');
    expect(done.state).toBe('succeeded');
    expect((done.value as Report).changedViews).toEqual([{ view: 'mcp_script_b', changed: ['metadata'], historyIndex: expect.any(Number), steps: 0 }]);
  });

  it('brings the image to the front once more right before the script, and ends the log it started', async () => {
    await run(session, 'prepare_script', { view: 'mcp_script_b' });
    const log = join(home, 'front.log');
    await session.cli.execute(USER_SLOT, session.paths.beginLogPath, [log, 'mcp_script_a']);
    await session.cli.execute(USER_SLOT, session.paths.endLogPath, []);
    const images = await run<Array<{ view: string; active: boolean }>>(session, 'list_images');
    expect(images.find((image) => image.active)?.view).toBe('mcp_script_a');
    expect(existsSync(log)).toBe(true);
  });

  it('does not start a script of the user that was changed after the server started, which would be a way to run code', async () => {
    expect((await start('McpLiveChanging')).log).toContain('MCPLIVE as the user left it');
    await writeFile(join(scriptsDir, 'McpLiveChanging.js'), `${CHANGING}new ImageWindow( 8, 8, 1, 32, true, false, "mcp_script_smuggled" ).show();\n`);
    expect((await start('McpLiveChanging')).error?.kind).toBe('script_changed');
    await writeFile(join(scriptsDir, 'McpLiveLater.js'), '#feature-id McpLiveLater : Utilities > McpLiveLater\n');
    expect((await start('McpLiveLater')).error?.kind).toBe('unknown_script');
    // Back to what it was, it is the script of the user again.
    await writeFile(join(scriptsDir, 'McpLiveChanging.js'), CHANGING);
    expect((await start('McpLiveChanging')).state).toBe('succeeded');
  });

  it('still cannot run a script with parameters from another script, which is why there is no unattended way', async () => {
    const done = await start('McpLiveRecursion');
    expect(done.state).toBe('succeeded');
    expect(done.log).toContain('MCPLIVE recursion=false');
    expect(done.log?.join('\n')).toMatch(/recursively/);
    // The script it tried to run would have made this image again.
    expect((done.value as Report).newViews).toEqual([]);
  });

  it('refuses what it must not start, and starts nothing', async () => {
    expect((await start('McpLiveNoSuchScript')).error?.kind).toBe('unknown_script');
    expect((await start('McpLiveStep', 'mcp_no_such_image')).error?.kind).toBe('unknown_view');
    expect((await start('McpLiveMount')).error?.kind).toBe('blocked_script');
    // The same holds for what PixInsight ships in such a menu, if it ships any.
    const shipped = (await session.scripts()).find((script) => script.source === 'shipped' && scriptBlockReason(script.menus));
    if (shipped) expect((await start(shipped.name)).error?.kind).toBe('blocked_script');
    const images = await run<Array<{ view: string }>>(session, 'list_images');
    expect(images.map((image) => image.view).sort()).toEqual(['mcp_script_a', 'mcp_script_b', 'mcp_script_made']);
  });


  describe('the dialog of a script, read and worked from outside', () => {
    const look = { waitMs: 30_000 };
    const open = async (script: string, view?: string): Promise<{ job: JobSnapshot; shown: ScriptView }> => {
      const job = session.startScript({ script, view });
      return { job, shown: (await session.watchScript(job.id, look)) as ScriptView };
    };
    const use = (action: DialogAction): Promise<ScriptView> => session.useScriptDialog(action, look);
    const refusal = (action: DialogAction): Promise<string> => use(action).then(() => 'not refused', (error: { kind?: string }) => error.kind ?? 'no kind');
    const fieldsOf = (view: ScriptView): Field[] => {
      if (view.kind !== 'dialog') throw new Error(`Expected a dialog, got ${view.kind}: ${JSON.stringify(view.kind === 'question' ? view.question : view.job.error ?? view.job.state)}`);
      return view.dialog.fields;
    };
    const id = (fields: Field[], type: string, text?: string): string => {
      const found = fields.find((field) => field.type === type && (text === undefined || field['text'] === text));
      if (!found) throw new Error(`No ${type} ${text ?? ''} among ${JSON.stringify(fields)}`);
      return found.id;
    };
    const endOf = (view: ScriptView): JobSnapshot => {
      if (view.kind !== 'done') throw new Error(`Expected the script to have ended, got ${view.kind}`);
      expect(view.job.state).toBe('succeeded');
      return view.job;
    };
    const lineOf = (job: JobSnapshot, start: string): string => job.log?.find((line) => line.startsWith(start))?.slice(start.length) ?? `no line "${start}" in ${JSON.stringify(job.log)}`;
    /**
     * What the handlers of the form noted, in order. A field tells its script that an edit is
     * complete whenever it loses the focus, which also happens when something else is pressed, so
     * only the first such note of a field counts.
     */
    const eventsOf = (job: JobSnapshot): string[] => {
      const seen = new Set<string>();
      const each = (job.log ?? []).filter((line) => line.startsWith('MCPLIVE event ')).map((line) => line.slice('MCPLIVE event '.length));
      return (each.length ? each : lineOf(job, 'MCPLIVE events ').split(' | '))
        .filter((event) => event !== 'edit:initial' && !(/^(edit|locked):/.test(event) && seen.has(event)) && Boolean(seen.add(event)));
    };
    /** PixInsight's own methods on the older engine, seen by a script that is started without the hook. */
    const nativeState = async (): Promise<string> => lineOf(await session.jobs.wait(session.startScript({ script: 'McpLiveNative', plain: true }).id, 30_000), 'MCPLIVE native ');
    /** The size a PNG file states in its header. */
    const pngSize = (bytes: Buffer) => ({ signature: bytes.subarray(1, 4).toString('latin1'), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
    /** The colour of one pixel of a PNG file with 8 bits per channel, as red, green and blue. */
    const pngPixel = (bytes: Buffer, x: number, y: number): number[] => {
      const { width } = pngSize(bytes);
      const channels = { 2: 3, 6: 4 }[bytes[25] as number];
      if (bytes[24] !== 8 || !channels) throw new Error(`A PNG of a kind this test does not read: ${bytes[24]} bits, colour type ${bytes[25]}`);
      const data: Buffer[] = [];
      for (let at = 8; at < bytes.length; ) {
        const length = bytes.readUInt32BE(at);
        if (bytes.subarray(at + 4, at + 8).toString('latin1') === 'IDAT') data.push(bytes.subarray(at + 8, at + 8 + length));
        at += 12 + length;
      }
      const raw = inflateSync(Buffer.concat(data));
      const stride = width * channels;
      let above = Buffer.alloc(stride);
      // Every row is stored as its difference to a neighbour, in one of five ways.
      for (let row = 0; ; row++) {
        const filter = raw[row * (stride + 1)] as number;
        const line = Buffer.from(raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1)));
        for (let i = 0; i < stride; i++) {
          const left = i >= channels ? (line[i - channels] as number) : 0;
          const up = above[i] as number;
          const upLeft = i >= channels ? (above[i - channels] as number) : 0;
          const p = left + up - upLeft;
          const paeth = Math.abs(p - left) <= Math.abs(p - up) && Math.abs(p - left) <= Math.abs(p - upLeft) ? left : Math.abs(p - up) <= Math.abs(p - upLeft) ? up : upLeft;
          line[i] = ((line[i] as number) + [0, left, up, Math.floor((left + up) / 2), paeth][filter]!) & 0xff;
        }
        if (row === y) return [...line.subarray(x * channels, x * channels + 3)];
        above = line;
      }
    };

    describe.each([
      ['the older engine', 'McpLiveForm', false],
      ['V8', 'McpLiveFormV8', true],
    ] as const)('of a script for %s', (_engine, script, v8) => {
      it('describes every field in reading order, also one the script keeps nowhere, and never reads out a password', async () => {
        const { shown } = await open(script);
        const fields = fieldsOf(shown);
        expect(shown).toMatchObject({ kind: 'dialog', dialog: { title: 'MCP live form' } });
        expect(fields.map((field) => [field.type, field['text'] ?? field['value'] ?? null])).toEqual([
          ['Label', 'Name of the target:'],
          ['Edit', 'initial'],
          ['Edit', null],
          ['CheckBox', 'Use the flag'],
          ['Edit', 'only with the flag'],
          ['ComboBox', 'First'],
          ['NumericControl', 'Amount:'],
          ['SpinBox', 3],
          ['TreeBox', null],
          ['Control', null],
          ['CheckBox', 'Not a property'],
          ['PushButton', 'Measure'],
          ['PushButton', 'Ask'],
          ['PushButton', 'Pick'],
          ['PushButton', 'Child'],
          ['PushButton', 'Fail'],
          ['PushButton', 'OK'],
          ['PushButton', 'Cancel'],
        ]);
        expect(fields[2]).toMatchObject({ secret: true });
        expect(JSON.stringify(shown)).not.toContain('MCPLIVE-SECRET');
        expect(fields[4]).toMatchObject({ enabled: false });
        expect(fields[5]).toMatchObject({ options: ['First', 'Second', 'Third'] });
        // The control with a label, an edit field and a slider is one field.
        expect(fields[6]).toMatchObject({ value: 0.25, range: [0, 1] });
        expect(fields[7]).toMatchObject({ range: [1, 10] });
        expect(fields[8]).toMatchObject({ columns: ['What', 'Value'], rows: [] });
        expect(fields[9]).toMatchObject({ drawn: true });

        // The picture is the dialog as PixInsight paints it, in the size the dialog has.
        const pictured = await session.scriptDialog({ ...look, picture: true, help: true });
        if (pictured.kind !== 'dialog' || !pictured.picture) throw new Error('Expected a dialog with a picture');
        expect(pngSize(await readFile(pictured.picture))).toEqual({ signature: 'PNG', width: pictured.dialog.size[0], height: pictured.dialog.size[1] });
        expect(pictured.dialog.fields[1]).toMatchObject({ help: 'The name of the thing.' });
        const [, top, , height] = pictured.dialog.fields[1]!['at'] as number[];
        expect(top).toBeGreaterThan(0);
        expect(height).toBeGreaterThan(10);

        // Closing is what the close button of the window does: the script learns that it was cancelled.
        const end = endOf(await use({ action: 'close' }));
        expect(JSON.parse(lineOf(end, 'MCPLIVE values '))).toMatchObject({ code: 0, name: 'initial' });
        expect(end.log?.join('\n')).not.toMatch(/\*\* Warning|\*\*\* Error/);
      });

      it('works the dialog as the user would: the script hears of every step, and ends with what was set', async () => {
        const fields = fieldsOf((await open(script)).shown);
        const [name, key, locked] = fields.filter((field) => field.type === 'Edit').map((field) => field.id) as [string, string, string];

        fieldsOf(await use({ action: 'set', field: name, value: 'M 31' }));
        // What the user could not do is refused, with the field as it was.
        expect(await refusal({ action: 'set', field: key, value: 'x' })).toBe('secret_field');
        expect(await refusal({ action: 'set', field: locked, value: 'x' })).toBe('field_disabled');
        fieldsOf(await use({ action: 'set', field: id(fields, 'CheckBox', 'Use the flag'), value: true }));
        // The script has enabled the field in its handler, as it does for a user.
        const unlocked = fieldsOf(await use({ action: 'set', field: locked, value: 'now it works' }));
        expect(unlocked.find((field) => field.id === locked)).toMatchObject({ value: 'now it works' });
        expect(unlocked.find((field) => field.id === locked)?.['enabled']).toBeUndefined();

        fieldsOf(await use({ action: 'set', field: id(fields, 'ComboBox'), value: 'third' }));
        expect(await refusal({ action: 'set', field: id(fields, 'ComboBox'), value: 'Fourth' })).toBe('invalid_value');
        fieldsOf(await use({ action: 'set', field: id(fields, 'NumericControl'), value: 0.8 }));
        expect(await refusal({ action: 'set', field: id(fields, 'NumericControl'), value: 3 })).toBe('invalid_value');
        fieldsOf(await use({ action: 'set', field: id(fields, 'SpinBox'), value: 7 }));
        fieldsOf(await use({ action: 'set', field: id(fields, 'CheckBox', 'Not a property'), value: true }));

        // A result that the script shows in its dialog only.
        const measured = fieldsOf(await use({ action: 'press', field: id(fields, 'PushButton', 'Measure') }));
        expect(measured.find((field) => field.type === 'TreeBox')).toMatchObject({ rows: [{ row: 0, cells: ['Median', '80.0'] }, { row: 1, cells: ['Count', '7'] }, { row: 2, cells: ['Name', 'M 31'] }], value: null });
        const selected = fieldsOf(await use({ action: 'set', field: id(fields, 'TreeBox'), value: 1 }));
        expect(selected.find((field) => field.type === 'TreeBox')).toMatchObject({ value: 1 });

        // Into the area the script draws itself, at a place taken from where the field lies.
        const pictured = await session.scriptDialog({ ...look, picture: true });
        const [left, top] = fieldsOf(pictured).find((field) => field.type === 'Control')!['at'] as number[];
        fieldsOf(await use({ action: 'click', x: left! + 30, y: top! + 10 }));
        expect(await refusal({ action: 'click', x: 3, y: 3 })).toBe('no_effect');

        // A handler of the script that fails does not end the script.
        expect(await refusal({ action: 'press', field: id(fields, 'PushButton', 'Fail') })).toBe('script_error');
        expect(await refusal({ action: 'press', field: 'f999' })).toBe('unknown_field');

        const end = endOf(await use({ action: 'press', field: id(fields, 'PushButton', 'OK') }));
        expect(JSON.parse(lineOf(end, 'MCPLIVE values '))).toEqual({ code: 1, name: 'M 31', flag: true, mode: 2, amount: 0.8, count: 7 });
        // With PixInsight's own name for the mouse button, which the script compared it with.
        expect(eventsOf(end)).toEqual(['edit:M 31', 'check:true', 'locked:now it works', 'combo:2', 'amount:0.8', 'count:7', 'unnamed:true', 'measure', 'row:Count', 'mouse:30,10,left', 'fail']);
        // The user can read in the console what was done to the dialog.
        expect(end.log).toEqual(expect.arrayContaining(['MCP: set CheckBox "Use the flag" to true', 'MCP: pressed PushButton "Measure"', 'MCP: selected row 1 of a table (Count, 7)']));
        // Nothing of the hook shows in the console of the user as a warning of the older engine.
        expect(end.log?.join('\n')).not.toMatch(/\*\* Warning/);
        expect((end.value as Report).changedViews).toEqual([]);
      });

      it('passes a message of the script on as a question, and gives the script the button that was answered', async () => {
        const fields = fieldsOf((await open(script)).shown);
        const asked = await use({ action: 'press', field: id(fields, 'PushButton', 'Ask') });
        expect(asked).toMatchObject({ kind: 'question', question: { kind: 'message', text: 'Replace the file?', caption: 'MCP live question', icon: 'question', buttons: ['yes', 'no'] } });
        // Nothing else can be done while the script waits for the answer, as with a real message box.
        expect(await refusal({ action: 'set', field: id(fields, 'SpinBox'), value: 5 })).toBe('question_open');
        expect(await refusal({ action: 'answer', value: 'maybe' })).toBe('invalid_value');
        fieldsOf(await use({ action: 'answer', value: 'no' }));

        // Again, and at once: an answer can be there before the window that asks is.
        for (const answer of ['yes', 'no', 'yes']) {
          expect((await use({ action: 'press', field: id(fields, 'PushButton', 'Ask') })).kind).toBe('question');
          fieldsOf(await use({ action: 'answer', value: answer }));
        }
        const end = endOf(await use({ action: 'press', field: id(fields, 'PushButton', 'OK') }));
        // By the names PixInsight has for these buttons, which the script compared the answer with.
        expect(eventsOf(end)).toEqual(['ask:no', 'ask:yes', 'ask:no', 'ask:yes']);
        expect(end.log).toContain('MCP: answered "Replace the file?" with no');
      });

      it('goes into a dialog that a button opened, and back to the first one when that is closed', async () => {
        const fields = fieldsOf((await open(script)).shown);
        const child = await use({ action: 'press', field: id(fields, 'PushButton', 'Child') });
        expect(child).toMatchObject({ kind: 'dialog', dialog: { title: 'MCP live child' } });
        const inChild = fieldsOf(child);
        expect(inChild.map((field) => [field.type, field['text'] ?? field['value']])).toEqual([['Edit', 'child value'], ['PushButton', 'OK']]);
        // The dialog underneath cannot be reached, as for the user.
        expect(await refusal({ action: 'press', field: id(fields, 'PushButton', 'Measure') })).toBe('unknown_field');
        fieldsOf(await use({ action: 'set', field: id(inChild, 'Edit'), value: 'typed into the child' }));
        expect(await use({ action: 'press', field: id(inChild, 'PushButton', 'OK') })).toMatchObject({ kind: 'dialog', dialog: { title: 'MCP live form' } });
        const end = endOf(await use({ action: 'press', field: id(fields, 'PushButton', 'OK') }));
        expect(eventsOf(end)).toEqual(['child:ok:typed into the child']);
      });

      it.runIf(v8)('answers a file chooser with a path, which the script then reads as if the user had picked the file', async () => {
        const fields = fieldsOf((await open(script)).shown);
        const picked = join(scriptsDir, 'McpLiveStep.js');
        const asked = await use({ action: 'press', field: id(fields, 'PushButton', 'Pick') });
        expect(asked).toMatchObject({ kind: 'question', question: { kind: 'open_file', caption: 'Pick a file for the test' } });
        expect(await refusal({ action: 'answer', value: join(scriptsDir, 'no-such-file.xisf') })).toBe('no_such_file');
        fieldsOf(await use({ action: 'answer', value: picked }));
        // Cancelled, the chooser says that nothing was picked.
        expect((await use({ action: 'press', field: id(fields, 'PushButton', 'Pick') })).kind).toBe('question');
        fieldsOf(await use({ action: 'close' }));
        const end = endOf(await use({ action: 'press', field: id(fields, 'PushButton', 'OK') }));
        expect(eventsOf(end)).toEqual([`file:${picked}`, 'file:none']);
      });
    });

    describe.each([
      ['the older engine', 'McpLiveKinds'],
      ['V8, also where its directive is written in capitals', 'McpLiveKindsV8'],
    ] as const)('with the other kinds of fields, in a script for %s', (_engine, script) => {
      const find = (fields: Field[], test: (field: Field) => boolean): Field => {
        const found = fields.find(test);
        if (!found) throw new Error(`No such field among ${JSON.stringify(fields)}`);
        return found;
      };
      const named = (fields: Field[], text: string) => find(fields, (field) => field['text'] === text);
      const ofType = (fields: Field[], type: string) => find(fields, (field) => field.type === type);

      it('describes each kind and sets it as its kind is set, and the script hears of each change once', async () => {
        const fields = fieldsOf((await open(script, 'mcp_script_b')).shown);
        expect(ofType(fields, 'TabBox')).toMatchObject({ options: ['Target', 'Output'], value: 'Target' });
        expect(named(fields, 'On the first page').type).toBe('Label');
        // What lies on a page that is not shown is no field, as for the user.
        expect(fields.some((field) => field['text'] === 'On the second page')).toBe(false);
        expect(named(fields, 'Reject outliers')).toMatchObject({ type: 'GroupBox', value: false });
        expect(named(fields, 'Inside the group').type).toBe('Label');
        expect(ofType(fields, 'Slider')).toMatchObject({ value: 0, range: [0, 10] });
        expect(named(fields, 'Mean')).toMatchObject({ type: 'RadioButton', value: true });
        expect(named(fields, 'Median')).toMatchObject({ type: 'RadioButton', value: false });
        expect(named(fields, 'Pin')).toMatchObject({ type: 'ToolButton', value: false });
        expect(ofType(fields, 'TextBox')).toMatchObject({ value: 'Notes of the script', readOnly: true });
        // A text that PixInsight shows as it stands is not taken for markup.
        expect(find(fields, (field) => field.type === 'Edit' && field['readOnly'] === true)).toMatchObject({ value: '<computed>' });
        const scale = find(fields, (field) => field.type === 'ComboBox' && !field['editable']);
        expect(scale).toMatchObject({ options: ['1', '2', '4', '<Auto>'], value: '1' });
        const free = find(fields, (field) => field['editable'] === true);
        expect(free).toMatchObject({ type: 'ComboBox', value: 'red' });
        expect(ofType(fields, 'ViewList').type).toBe('ViewList');
        expect(named(fields, 'Precise:')).toMatchObject({ type: 'NumericEdit', value: 0.125, range: [0, 1] });
        expect(find(fields, (field) => field['secret'] === true).type).toBe('Edit');

        const second = fieldsOf(await use({ action: 'set', field: ofType(fields, 'TabBox').id, value: 'Output' }));
        expect(ofType(second, 'TabBox')).toMatchObject({ value: 'Output' });
        expect(second.some((field) => field['text'] === 'On the first page')).toBe(false);
        fieldsOf(await use({ action: 'set', field: named(second, 'On the second page').id, value: true }));
        fieldsOf(await use({ action: 'set', field: named(fields, 'Reject outliers').id, value: true }));
        fieldsOf(await use({ action: 'set', field: ofType(fields, 'Slider').id, value: 7 }));
        fieldsOf(await use({ action: 'set', field: named(fields, 'Median').id, value: true }));
        expect(named(fieldsOf(await use({ action: 'press', field: named(fields, 'Pin').id })), 'Pin')).toMatchObject({ value: true });
        // The option that is called 2, which is the second one, and then the one at place 3.
        fieldsOf(await use({ action: 'set', field: scale.id, value: 2 }));
        expect(find(fieldsOf(await use({ action: 'set', field: scale.id, value: 3 })), (field) => field.id === scale.id)).toMatchObject({ value: '<Auto>' });
        fieldsOf(await use({ action: 'set', field: free.id, value: 'deep red' }));
        expect(ofType(fieldsOf(await use({ action: 'set', field: ofType(fields, 'ViewList').id, value: 'mcp_script_a' })), 'ViewList')).toMatchObject({ value: 'mcp_script_a' });
        expect(await refusal({ action: 'set', field: ofType(fields, 'ViewList').id, value: 'mcp_no_such_image' })).toBe('invalid_value');
        fieldsOf(await use({ action: 'set', field: named(fields, 'Precise:').id, value: 0.5 }));
        expect(await refusal({ action: 'set', field: ofType(fields, 'TextBox').id, value: 'x' })).toBe('not_settable');
        expect(await refusal({ action: 'set', field: find(fields, (field) => field['readOnly'] === true && field.type === 'Edit').id, value: 'x' })).toBe('not_settable');
        // A click is for what a script draws itself. On a field it is refused, with the field to use.
        const pictured = await session.scriptDialog({ ...look, picture: true });
        const [left, top] = named(fieldsOf(pictured), 'Median')['at'] as number[];
        expect(await refusal({ action: 'click', x: left! + 4, y: top! + 4 })).toBe('not_clickable');

        const end = endOf(await use({ action: 'press', field: named(fields, 'OK').id }));
        // The list of images tells the script by itself, so it must have heard it once and not twice.
        expect(eventsOf(end)).toEqual(['page:1', 'second:true', 'group:true', 'slider:7', 'median:true', 'pin:true', 'scale:1', 'scale:3', 'free:deep red', 'view:mcp_script_a', 'precise:0.5']);
        expect(end.log?.join('\n')).not.toMatch(/\*\* Warning|\*\*\* Error/);
      });

      it('keeps a key to itself for good, also in the picture, once the script is told to show it', async () => {
        const fields = fieldsOf((await open(script)).shown);
        const key = find(fields, (field) => field['secret'] === true);
        expect(JSON.stringify(fields)).not.toContain('MCPLIVE-KEY');
        // The script now shows what the field holds, as a "show" box next to a key does.
        const shown = fieldsOf(await use({ action: 'set', field: named(fields, 'Show the key').id, value: true }));
        expect(find(shown, (field) => field.id === key.id)).toMatchObject({ secret: true });
        expect(JSON.stringify(shown)).not.toContain('MCPLIVE-KEY');
        expect(await refusal({ action: 'set', field: key.id, value: 'x' })).toBe('secret_field');

        const pictured = await session.scriptDialog({ ...look, picture: true });
        if (pictured.kind !== 'dialog' || !pictured.picture) throw new Error('Expected a dialog with a picture');
        const [left, top, width, height] = find(pictured.dialog.fields, (field) => field.id === key.id)['at'] as [number, number, number, number];
        const picture = await readFile(pictured.picture);
        // The field is painted over in one grey, from corner to corner.
        for (const [x, y] of [[left + 2, top + 2], [left + Math.floor(width / 2), top + Math.floor(height / 2)], [left + width - 3, top + height - 3]] as const) {
          expect(pngPixel(picture, x, y), `${x}, ${y}`).toEqual([128, 128, 128]);
        }
        // And the field above it is not, which shows that the picture is otherwise what PixInsight paints.
        expect(pngPixel(picture, left + 2, top - 12)).not.toEqual([128, 128, 128]);
        endOf(await use({ action: 'press', field: named(fields, 'OK').id }));
      });
    });

    describe.each([
      ['the older engine', 'McpLiveTables', false],
      ['V8', 'McpLiveTablesV8', true],
    ] as const)('with tables as WBPP has them, in a script for %s', (_engine, script, v8) => {
      type Row = { row: number; level?: number; cells: string[]; inside?: number };
      const table = (fields: Field[], heading: string): Field => {
        const found = fields.find((field) => field.type === 'TreeBox' && (field['columns'] as string[]).includes(heading));
        if (!found) throw new Error(`No table with the column ${heading} among ${JSON.stringify(fields)}`);
        return found;
      };
      const changesOf = (view: ScriptView) => {
        if (view.kind !== 'dialog' || !view.changes) throw new Error(`Expected what changed in the dialog, got ${JSON.stringify(view).slice(0, 300)}`);
        return view.changes;
      };
      const one = async (field: string, from?: number): Promise<Field> => {
        const view = await session.scriptField({ field, from }, look);
        if (view.kind !== 'field') throw new Error(`Expected one field, got ${view.kind}`);
        return view.field;
      };

      it('finds a table that is not kept on the dialog, selects a row by its number, and keeps the name of a table that is swapped for its twin', async () => {
        const fields = fieldsOf((await open(script)).shown);
        const groups = table(fields, 'LIGHT');
        // The table counts from 1 in a column of its own. A row comes with the number it is selected by, and the column that only fills the width is left out.
        expect(groups).toMatchObject({ columns: ['#', 'LIGHT', 'Filter'], rows: [{ row: 0, cells: ['1', '10 frames', 'H'] }, { row: 1, cells: ['2', '42 frames', 'L'] }] });
        // Of the two tables in that place, the hidden one is no field.
        expect(fields.filter((field) => field.type === 'TreeBox' && (field['columns'] as string[]).includes('LIGHT'))).toHaveLength(1);
        // A button that shows no word says what it is for.
        expect(fields.find((field) => field.type === 'ToolButton')).toMatchObject({ text: '', help: 'Settings of the registration.' });
        if (v8) {
          // Only V8 lets the server see what a script makes, wherever the script keeps it, also of a class of its own.
          expect(table(fields, 'Kept nowhere').type).toBe('TreeBox');
          expect(table(fields, 'Of a class of the script').type).toBe('TreeBox');
        }

        // After an action, only what is different comes back.
        const selected = changesOf(await use({ action: 'set', field: groups.id, value: 1 }));
        expect(selected.changed).toEqual([{ id: groups.id, type: 'TreeBox', value: 1, selected: ['2', '42 frames', 'L'] }]);
        expect(selected).toMatchObject({ added: [], gone: [] });

        // The script shows the twin in place of the table. To a reader it is the same field, without a selected row now.
        const redrawn = changesOf(await use({ action: 'press', field: fields.find((field) => field['text'] === 'Redraw')!.id }));
        expect(redrawn).toMatchObject({ added: [], gone: [], changed: [{ id: groups.id, type: 'TreeBox', value: null, selected: null }] });
        expect(changesOf(await use({ action: 'set', field: groups.id, value: 0 })).changed).toEqual([{ id: groups.id, type: 'TreeBox', value: 0, selected: ['1', '10 frames', 'H'] }]);
        expect(await refusal({ action: 'set', field: groups.id, value: 2 })).toBe('invalid_value');

        const end = endOf(await use({ action: 'press', field: fields.find((field) => field['text'] === 'OK')!.id }));
        const events = eventsOf(end);
        // The first one is PixInsight's own, for the table a dialog opens with. Then one for each row that was selected.
        expect(events.filter((event) => event.startsWith('group:'))).toEqual(['group:10 frames', 'group:42 frames', 'group:10 frames']);
        if (v8) expect(events).toContain('own:true:true:true');
        expect(end.log?.join('\n')).not.toMatch(/\*\* Warning|\*\*\* Error/);
        expect(end.log).toContain('MCP: selected row 1 of a table (2, 42 frames, L)');
      });

      it('lists the rows inside rows as deep as they fit, reads the table in full by itself, and opens up what hides a row it selects', async () => {
        const fields = fieldsOf((await open(script)).shown);
        const files = table(fields, 'Light frames');
        // The column that the script hides is none. The 73 rows of files do not fit, so the rows above them say how many they hold.
        expect(files).toMatchObject({ columns: ['Light frames', 'Time'], moreRows: 73, value: null });
        expect(files['rows']).toEqual([
          { row: 0, cells: ['Binning 1', ''] },
          { row: 1, level: 1, cells: ['H', ''] },
          { row: 2, level: 2, cells: ['SESSION: 1 (2 frames)', ''], inside: 2 },
          { row: 5, level: 2, cells: ['SESSION: 2 (1 frame)', ''], inside: 1 },
          { row: 7, level: 1, cells: ['O', ''] },
          { row: 8, level: 2, cells: ['SESSION: 1 (70 frames)', ''], inside: 70 },
        ]);
        const all = await one(files.id, 3);
        expect(all).toMatchObject({ id: files.id, type: 'TreeBox', totalRows: 79, from: 3 });
        const rows = all['rows'] as Row[];
        expect(rows).toHaveLength(76);
        expect(rows.slice(0, 3)).toEqual([
          { row: 3, level: 3, cells: ['a.fits', '21:00'] },
          { row: 4, level: 3, cells: ['b.fits', '21:05'] },
          { row: 5, level: 2, cells: ['SESSION: 2 (1 frame)', ''] },
        ]);
        expect(rows.at(-1)).toEqual({ row: 78, level: 3, cells: ['o69.fits', '23:00'] });

        expect(changesOf(await use({ action: 'set', field: files.id, value: 4 })).changed).toEqual([{ id: files.id, type: 'TreeBox', value: 4, selected: ['b.fits', '21:05'] }]);
        expect(await refusal({ action: 'set', field: files.id, value: 79 })).toBe('invalid_value');

        const end = endOf(await use({ action: 'press', field: fields.find((field) => field['text'] === 'OK')!.id }));
        expect(eventsOf(end).filter((event) => event.startsWith('file:'))).toEqual(['file:b.fits']);
        // The rows above the selected one were folded up, and are open now. The one beside them is not.
        expect(lineOf(end, 'MCPLIVE expanded ')).toBe('true true true false');
        expect(end.log?.join('\n')).not.toMatch(/\*\* Warning|\*\*\* Error/);
      });

      it('shows the start of a long text with how much is left, and reads the rest of it in parts', async () => {
        const fields = fieldsOf((await open(script)).shown);
        const report = fields.find((field) => field.type === 'TextBox')!;
        expect(report['value']).toHaveLength(6000);
        expect(report).toMatchObject({ more: 19001, readOnly: true });
        const start = await one(report.id);
        expect(start['value']).toHaveLength(20000);
        expect(start).toMatchObject({ more: 5000 });
        const rest = await one(report.id, 20000);
        expect(rest).toMatchObject({ from: 20000, value: '0123456789'.repeat(500) });
        expect(rest['more']).toBeUndefined();
        await expect(session.scriptField({ field: 'f999' }, look)).rejects.toMatchObject({ kind: 'unknown_field' });
        endOf(await use({ action: 'press', field: fields.find((field) => field['text'] === 'OK')!.id }));
      });

      it('waits for a button that the script enables when its work is over, instead of being asked again and again', async () => {
        const done = join(scriptsDir, 'work-done.txt');
        await rm(done, { force: true });
        try {
          const fields = fieldsOf((await open(script)).shown);
          const finished = fields.find((field) => field['text'] === 'Finished')!;
          expect(finished).toMatchObject({ type: 'PushButton', enabled: false });
          await use({ action: 'press', field: fields.find((field) => field['text'] === 'Work')!.id });
          // The work is not over, so the wait comes back with nothing but that.
          expect(await session.scriptDialog({ waitMs: 5000, until: 'Finished' })).toMatchObject({ kind: 'none', why: 'not_yet' });
          // Now it ends, and the wait with it.
          await writeFile(done, '');
          const shown = fieldsOf(await session.scriptDialog({ waitMs: 55_000, until: 'finished' }));
          expect(shown.find((field) => field.id === finished.id)).not.toHaveProperty('enabled');
          await use({ action: 'press', field: finished.id });
          const end = endOf(await use({ action: 'press', field: fields.find((field) => field['text'] === 'OK')!.id }));
          expect(eventsOf(end).filter((event) => event === 'worked' || event === 'finished')).toEqual(['worked', 'finished']);
          expect(end.log?.join('\n')).not.toMatch(/\*\* Warning|\*\*\* Error/);
        } finally {
          await rm(done, { force: true });
        }
      });

      it('finds the area a scroll box shows, which a script draws its preview on, and clicks into it', async () => {
        const fields = fieldsOf((await open(script)).shown);
        const preview = fields.find((field) => field.type === 'Control' && field['drawn'] === true && field['clicks'] === true);
        if (!preview) throw new Error(`No drawn area among ${JSON.stringify(fields)}`);
        const [left, top] = preview['at'] as number[];
        fieldsOf(await use({ action: 'click', x: left! + 12, y: top! + 12 }));
        // Where nothing takes a click, a click is refused, on the older engine without asking PixInsight what lies there.
        const [boxLeft, boxTop] = fields.find((field) => field.type === 'TextBox')!['at'] as number[];
        expect(await refusal({ action: 'click', x: boxLeft! + 4, y: boxTop! + 1 })).toBe('not_clickable');
        const end = endOf(await use({ action: 'press', field: fields.find((field) => field['text'] === 'OK')!.id }));
        expect(eventsOf(end).filter((event) => event.startsWith('preview:'))).toEqual(['preview:1']);
        expect(end.log?.join('\n')).not.toMatch(/\*\* Warning|\*\*\* Error/);
      });
    });

    it('answers a script for V8 that asks where to write, for a folder and for several files, and never names a file to replace by itself', async () => {
      const fields = fieldsOf((await open('McpLiveKindsV8')).shown);
      const press = (text: string) => use({ action: 'press', field: id(fields, 'PushButton', text) });
      const existing = join(scriptsDir, 'McpLiveStep.js');
      const fresh = join(home, 'result of the test.xisf');

      expect(await press('Save')).toMatchObject({ kind: 'question', question: { kind: 'save_file', caption: 'Save the result of the test' } });
      expect(await refusal({ action: 'answer', value: existing })).toBe('file_exists');
      expect(await refusal({ action: 'answer', value: 'relative.xisf' })).toBe('invalid_path');
      fieldsOf(await use({ action: 'answer', value: fresh }));
      // Only with the word of the user does the script get a file that exists.
      expect((await press('Save')).kind).toBe('question');
      fieldsOf(await use({ action: 'answer', value: existing, allowOverwrite: true }));

      expect(await press('Folder')).toMatchObject({ kind: 'question', question: { kind: 'directory', caption: 'Pick a folder for the test' } });
      expect(await refusal({ action: 'answer', value: existing })).toBe('no_such_file');
      fieldsOf(await use({ action: 'answer', value: scriptsDir }));

      expect(await press('Several')).toMatchObject({ kind: 'question', question: { kind: 'open_file', multiple: true } });
      fieldsOf(await use({ action: 'answer', value: [existing, join(scriptsDir, 'McpLiveSilent.js')] }));

      // A dialog that the script made before its main one, and opens from it, is the one on top.
      const settings = await press('Settings');
      expect(settings).toMatchObject({ kind: 'dialog', dialog: { title: 'MCP live settings' } });
      expect(fieldsOf(settings).map((field) => field['value'])).toEqual(['made before the dialog that opens it']);
      expect(await use({ action: 'close' })).toMatchObject({ kind: 'dialog', dialog: { title: 'MCP live kinds' } });

      const end = endOf(await press('OK'));
      expect(eventsOf(end)).toEqual([`save:${fresh}`, `save:${existing}`, `folder:${scriptsDir}`, `several:${existing}+${join(scriptsDir, 'McpLiveSilent.js')}`, 'settings:0']);
      // Nothing was written: the script only asked.
      expect(existsSync(fresh)).toBe(false);
    });

    it.each(['McpLiveLoop', 'McpLiveLoopV8'])('takes each showing of a dialog that %s shows again and again as one of its own', async (script) => {
      const { shown } = await open(script);
      const again = id(fieldsOf(shown), 'PushButton', 'Again');
      expect(fieldsOf(shown).map((field) => field['text'])).toEqual(['Round 1', 'Again']);
      // The press ends this showing, and what comes back is the next one, read anew.
      expect(fieldsOf(await use({ action: 'press', field: again })).map((field) => field['text'])).toEqual(['Round 2', 'Again']);
      expect(fieldsOf(await use({ action: 'press', field: again })).map((field) => field['text'])).toEqual(['Round 3', 'Again']);
      expect(lineOf(endOf(await use({ action: 'press', field: again })), 'MCPLIVE rounds ')).toBe('3');
    });

    it('still works a dialog that has been open for longer than the server may be silent', { timeout: 60_000 }, async () => {
      const fields = fieldsOf((await open('McpLiveForm')).shown);
      // Longer than the 15 s after which a script takes the server for gone.
      await new Promise((resolve) => setTimeout(resolve, 17_000));
      const measured = fieldsOf(await use({ action: 'press', field: id(fields, 'PushButton', 'Measure') }));
      expect(measured.find((field) => field.type === 'TreeBox')?.['rows']).toHaveLength(3);
      endOf(await use({ action: 'close' }));
    });

    it.each(['McpLiveAsk', 'McpLiveAskV8'])('answers what %s asks before it shows any dialog', async (script) => {
      const { shown } = await open(script);
      expect(shown).toMatchObject({ kind: 'question', question: { kind: 'message', text: 'No image is open. Go on?', icon: 'warning', buttons: ['yes', 'no', 'cancel'] } });
      await expect(session.scriptDialog({ waitMs: 500 })).resolves.toMatchObject({ kind: 'question' });
      const end = endOf(await use({ action: 'answer', value: 'cancel' }));
      expect(lineOf(end, 'MCPLIVE answered ')).toBe('cancel');
    });

    it('leaves the older engine as it found it, which keeps its scope for the scripts the user starts afterwards', async () => {
      // After all the scripts above, and three more in a row.
      for (let round = 0; round < 3; round++) {
        const { shown } = await open('McpLiveForm');
        fieldsOf(shown);
        endOf(await use({ action: 'close' }));
      }
      expect(await nativeState()).toBe('execute=true ask=true layout=true hook=undefined');
      // While a script runs, the methods are replaced, and afterwards they are PixInsight's own again.
      const { shown } = await open('McpLiveSelfClosing');
      expect(shown).toMatchObject({ kind: 'dialog', dialog: { title: 'MCP live self closing' } });
      const closed = await session.jobs.wait(shown.job.id, 30_000);
      expect(lineOf(closed, 'MCPLIVE self closing: ')).toBe('before execute=false ask=false layout=false hook=function; after execute=false ask=false layout=false hook=function');
      expect(await nativeState()).toBe('execute=true ask=true layout=true hook=undefined');
    });

    it('puts PixInsight\'s methods back by itself where the script that cleans up never arrived and nobody waits any more', async () => {
      // The file the server would send, with a folder in which the server says that it has given up.
      const dir = join(home, 'abandoned');
      const found = join(dir, 'found.txt');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'awaited'), '0');
      await writeFile(join(dir, 'start.js'), wrapperFor(await readFile(session.paths.dialogHookPath, 'utf8'), dir, join(scriptsDir, 'McpLiveSelfClosing.js'), 'classic', 'operate'));
      await session.cli.execute(USER_SLOT, join(dir, 'start.js'), [found, 'soon']);
      // PixInsight takes one script after the other, so this one runs when that one has ended.
      const after = await nativeState();
      // Replaced when the script began, PixInsight's own again the moment the script opened its dialog.
      expect(await readFile(found, 'utf8')).toBe('before execute=false ask=false layout=false hook=function; after execute=true ask=true layout=true hook=undefined');
      expect(after).toBe('execute=true ask=true layout=true hook=undefined');
    });

    it('only reads a dialog where the user allows no more', async () => {
      const reading = await Session.create({ ...config(), scriptDialogs: 'read' });
      try {
        const job = reading.startScript({ script: 'McpLiveSelfClosing' });
        const shown = (await reading.watchScript(job.id, look)) as ScriptView;
        expect(shown).toMatchObject({ kind: 'dialog', dialog: { title: 'MCP live self closing' } });
        await expect(reading.useScriptDialog({ action: 'close' }, look)).rejects.toMatchObject({ kind: 'read_only' });
        expect((await reading.jobs.wait(job.id, 30_000)).state).toBe('succeeded');
      } finally {
        // Not close(): that would stop the shadow instance both sessions could use.
        await reading.jobs.close();
      }
    });

    it('does not start a signed script that was changed after it was signed, which PixInsight would not run either', async () => {
      const shipped = (await session.scripts()).find((each) => each.name === 'NoiseEvaluation');
      if (!shipped || !existsSync(shipped.path.replace(/\.js$/, '.xsgn'))) return;
      await run(session, 'prepare_script', { script: shipped.path });
      // A script without a signature runs, as it does from the Script menu.
      await run(session, 'prepare_script', { script: join(scriptsDir, 'McpLiveStep.js') });
      // A copy for this test alone, with one line added.
      const changed = join(home, 'Changed.js');
      await copyFile(shipped.path, changed);
      await copyFile(shipped.path.replace(/\.js$/, '.xsgn'), join(home, 'Changed.xsgn'));
      await writeFile(changed, `${await readFile(changed, 'latin1')}\nconsole.writeln( "MCPLIVE must not run" );\n`, 'latin1');
      await expect(run(session, 'prepare_script', { script: changed })).rejects.toThrow(/bad_signature/);
    });
  });

  // Last, because nobody can close this dialog in an instance without a window: it has to be ended.
  it('waits while a script that was started plainly shows its dialog, lets nothing else through, and reports the loss of the instance', async () => {
    const job = session.startScript({ script: 'McpLiveDialog', plain: true });
    expect(await session.watchScript(job.id, { waitMs: 1000 })).toBeNull();
    await expect(session.scriptDialog({ waitMs: 1000 })).rejects.toMatchObject({ kind: 'no_dialog_access' });
    const pending = await session.jobs.wait(job.id, 3000);
    expect(pending).toMatchObject({ done: false, state: 'sent' });

    const behind = session.jobs.submit('list_images', {});
    const deadline = Date.now() + 20_000;
    while (!(await session.jobs.get(job.id))?.waitingForInput && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await session.jobs.get(job.id)).toMatchObject({ done: false, state: 'sent', waitingForInput: true });
    expect((await session.jobs.get(behind.id))?.state).toBe('queued');

    // Only ever the instance this test started itself.
    const pid = user.current()?.pid;
    expect(pid).toEqual(expect.any(Number));
    expect((await session.instances())?.find((instance) => instance.slot === USER_SLOT)?.pid).toBe(pid);
    process.kill(pid as number, 'SIGKILL');
    user.invalidate();

    expect(await session.jobs.wait(job.id, 20_000)).toMatchObject({ state: 'lost', error: { kind: 'instance_lost' } });
  });
});

describe.skipIf(!existsSync(EXECUTABLE))('code of the assistant', { timeout: 120_000 }, () => {
  let live: LiveSession;
  const code = async (source: string): Promise<JobSnapshot> => live.session.jobs.wait(live.session.runCode(source).id, 60_000);

  beforeAll(async () => {
    live = await startLiveSession({ allowCode: true });
  }, 120_000);

  afterAll(async () => {
    await live?.cleanup();
  });

  it('returns what the code returns, also values that JSON has no type for', async () => {
    const done = await code('return { build: CoreApplication.versionBuild, big: 12345678901234567890n, typed: new Float32Array( [ 0.5, 0.25 ] ) };');
    expect(done.state).toBe('succeeded');
    expect(done.value).toMatchObject({ value: { build: expect.any(Number), big: '12345678901234567890', typed: [0.5, 0.25] }, newViews: [], closedViews: [], changedViews: [] });
    expect((await code('const nothing = 1;')).value).toMatchObject({ value: null });
  });

  it('reports the images the code made and changed, and what it wrote to the console', async () => {
    const made = await code(`
      const window = new ImageWindow( 24, 12, 1, 32, true, false, "mcp_code" );
      window.show();
      const view = window.mainView;
      view.beginProcess();
      view.image.fill( 0.25 );
      view.endProcess();
      console.writeln( "MCPCODE filled" );
      return view.image.median();`);
    expect(made.state).toBe('succeeded');
    expect(made.value).toMatchObject({ value: 0.25, newViews: ['mcp_code'] });
    expect(made.log).toContain('MCPCODE filled');

    const changed = await code('const view = View.viewById( "mcp_code" ); view.beginProcess(); view.image.fill( 0.5 ); view.endProcess(); return 1;');
    const [change] = (changed.value as Report).changedViews;
    expect(change).toEqual({ view: 'mcp_code', changed: ['history'], historyIndex: expect.any(Number), steps: 1 });
    expect(await median(live.session, 'mcp_code')).toBeCloseTo(0.5, 5);
    // A step between beginProcess and endProcess is in the history, as the tool tells the assistant.
    await run(live.session, 'undo', { view: 'mcp_code', count: change!.steps, historyIndex: change!.historyIndex });
    expect(await median(live.session, 'mcp_code')).toBeCloseTo(0.25, 5);
  });

  it('says so when the code changed pixels with no step in the history', async () => {
    const done = await code('const view = View.viewById( "mcp_code" ); view.beginProcess( UndoFlag.NoSwapFile ); view.image.fill( 0.9 ); view.endProcess(); return 1;');
    expect((done.value as Report).changedViews).toEqual([
      { view: 'mcp_code', changed: ['pixels'], historyIndex: expect.any(Number), steps: 0, note: expect.stringMatching(/no step in the history/) },
    ]);
    expect(await median(live.session, 'mcp_code')).toBeCloseTo(0.9, 5);
  });

  it('explains code that does not compile, and code that throws, with the line and with what it left behind', async () => {
    const broken = await code('const a = ;');
    expect(broken).toMatchObject({ state: 'failed', error: { kind: 'code_error', message: expect.stringMatching(/does not compile/) } });

    const thrown = await code('const a = 1;\nnew ImageWindow( 8, 8, 1, 32, true, false, "mcp_code_left" ).show();\nnoSuchFunction();\nreturn a;');
    expect(thrown.state).toBe('failed');
    expect(thrown.error?.kind).toBe('code_error');
    expect(thrown.error?.message).toMatch(/The code threw \(line 3\): .*noSuchFunction/);
    expect(thrown.error?.message).toMatch(/left behind: new images mcp_code_left\./);
  });

  it('refuses a value that would flood the conversation, and one that is no value', async () => {
    expect((await code('return "x".repeat( 70000 );')).error).toMatchObject({ kind: 'code_error', message: expect.stringMatching(/70002 characters/) });
    expect((await code('return Promise.resolve( 1 );')).error).toMatchObject({ kind: 'code_error', message: expect.stringMatching(/promise/) });
    expect((await code('const a = {}; a.self = a; return a;')).error).toMatchObject({ kind: 'code_error', message: expect.stringMatching(/cannot be turned into JSON/) });
  });

  it('does not run in a server where the user has not turned it on', async () => {
    const config = { ...live.config, allowCode: false };
    const plain = await Session.create(config);
    const done = await plain.jobs.wait(plain.runCode('return 1;').id, 30_000);
    expect(done.error?.kind).toBe('blocked_code');
    // Not close(): that would stop the instance both sessions use.
    await plain.jobs.close();
  });
});
