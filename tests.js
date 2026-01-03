/**
 * open-vtt Test Suite
 * 
 * Run tests manually via console: OpenVTTTests.runAll()
 * Tests parser robustness, VTT parsing, and voice type detection.
 * 
 * @license MIT
 */

// =============================================================================
// TEST FRAMEWORK
// =============================================================================

const TestRunner = {
    passed: 0,
    failed: 0,
    results: [],

    assert(condition, testName, details = '') {
        if (condition) {
            this.passed++;
            this.results.push({ status: '✅', name: testName });
        } else {
            this.failed++;
            this.results.push({ status: '❌', name: testName, details });
            console.error(`❌ FAILED: ${testName}`, details);
        }
    },

    assertEqual(actual, expected, testName) {
        const pass = JSON.stringify(actual) === JSON.stringify(expected);
        this.assert(pass, testName, pass ? '' : `Expected: ${JSON.stringify(expected)}, Got: ${JSON.stringify(actual)}`);
    },

    assertType(cues, index, expectedType, testName) {
        const cue = cues[index];
        if (!cue) {
            this.assert(false, testName, `No cue at index ${index}`);
            return;
        }
        this.assertEqual(cue.type, expectedType, testName);
    },

    report() {
        console.log('\n' + '='.repeat(60));
        console.log(`📊 open-vtt Test Results: ${this.passed} passed, ${this.failed} failed`);
        console.log('='.repeat(60));

        if (this.failed > 0) {
            console.log('\n❌ Failed Tests:');
            this.results.filter(r => r.status === '❌').forEach(r => {
                console.log(`  ${r.name}: ${r.details}`);
            });
        }

        return this.failed === 0;
    },

    reset() {
        this.passed = 0;
        this.failed = 0;
        this.results = [];
    }
};

// =============================================================================
// PARSER TESTS
// =============================================================================

function runParserTests() {
    console.log('\n🧪 Running Parser Tests...\n');
    TestRunner.reset();

    // -------------------------------------------------------------------
    // Test 1: Basic voice span parsing
    // -------------------------------------------------------------------
    const vtt1 = `WEBVTT

00:01.000 --> 00:05.000
<v Description>A scenic view of mountains.</v>`;

    let result = parseVTT(vtt1);
    TestRunner.assertEqual(result.cues.length, 1, 'Basic voice span: cue count');
    TestRunner.assertType(result.cues, 0, 'description', 'Basic voice span: type is description');

    // -------------------------------------------------------------------
    // Test 2: Case-insensitive voice types
    // -------------------------------------------------------------------
    const vtt2 = `WEBVTT

00:01.000 --> 00:02.000
<v DESCRIPTION>Uppercase description</v>

00:02.000 --> 00:03.000
<v Description>Mixed case</v>

00:03.000 --> 00:04.000
<v description>Lowercase</v>`;

    result = parseVTT(vtt2);
    TestRunner.assertEqual(result.cues.length, 3, 'Case insensitive: cue count');
    TestRunner.assertType(result.cues, 0, 'description', 'Case insensitive: UPPERCASE');
    TestRunner.assertType(result.cues, 1, 'description', 'Case insensitive: Mixed');
    TestRunner.assertType(result.cues, 2, 'description', 'Case insensitive: lowercase');

    // -------------------------------------------------------------------
    // Test 3: Voice type aliases
    // -------------------------------------------------------------------
    const vtt3 = `WEBVTT

00:01.000 --> 00:02.000
<v Desc>Short alias</v>

00:02.000 --> 00:03.000
<v Visual>Visual type</v>

00:03.000 --> 00:04.000
<v Scene Description>Scene desc</v>

00:04.000 --> 00:05.000
<v AD>Audio description alias</v>`;

    result = parseVTT(vtt3);
    TestRunner.assertEqual(result.cues.length, 4, 'Aliases: cue count');
    TestRunner.assertType(result.cues, 0, 'description', 'Alias: Desc');
    TestRunner.assertType(result.cues, 1, 'description', 'Alias: Visual');
    TestRunner.assertType(result.cues, 2, 'description', 'Alias: Scene Description');
    TestRunner.assertType(result.cues, 3, 'description', 'Alias: AD');

    // -------------------------------------------------------------------
    // Test 4: Curatorial aliases
    // -------------------------------------------------------------------
    const vtt4 = `WEBVTT

00:01.000 --> 00:02.000
<v Curatorial>Curatorial content</v>

00:02.000 --> 00:03.000
<v Extended>Extended content</v>

00:03.000 --> 00:04.000
<v Archival>Archival content</v>

00:04.000 --> 00:05.000
<v Context>Context info</v>`;

    result = parseVTT(vtt4);
    TestRunner.assertEqual(result.cues.length, 4, 'Curatorial aliases: cue count');
    TestRunner.assertType(result.cues, 0, 'curatorial', 'Curatorial alias: Curatorial');
    TestRunner.assertType(result.cues, 1, 'curatorial', 'Curatorial alias: Extended');
    TestRunner.assertType(result.cues, 2, 'curatorial', 'Curatorial alias: Archival');
    TestRunner.assertType(result.cues, 3, 'curatorial', 'Curatorial alias: Context');

    // -------------------------------------------------------------------
    // Test 5: Sound effects
    // -------------------------------------------------------------------
    const vtt5 = `WEBVTT

00:01.000 --> 00:02.000
<v Sound>Door opens</v>

00:02.000 --> 00:03.000
<v SFX>Footsteps</v>

00:03.000 --> 00:04.000
[music]

00:04.000 --> 00:05.000
[applause]`;

    result = parseVTT(vtt5);
    TestRunner.assertEqual(result.cues.length, 4, 'Sound effects: cue count');
    TestRunner.assertType(result.cues, 0, 'sound', 'Sound: via <v Sound>');
    TestRunner.assertType(result.cues, 1, 'sound', 'Sound: via <v SFX>');
    TestRunner.assertType(result.cues, 2, 'sound', 'Sound: [music] bracket');
    TestRunner.assertType(result.cues, 3, 'sound', 'Sound: [applause] bracket');

    // -------------------------------------------------------------------
    // Test 6: Speaker names (subtitle type)
    // -------------------------------------------------------------------
    const vtt6 = `WEBVTT

00:01.000 --> 00:05.000
<v John Smith>Hello, how are you?</v>

00:05.000 --> 00:10.000
<v Mary Jones>I'm doing well, thanks!</v>`;

    result = parseVTT(vtt6);
    TestRunner.assertEqual(result.cues.length, 2, 'Speakers: cue count');
    TestRunner.assertType(result.cues, 0, 'subtitle', 'Speaker: John Smith is subtitle');
    TestRunner.assertEqual(result.cues[0].speaker, 'John Smith', 'Speaker: name extracted');
    TestRunner.assertType(result.cues, 1, 'subtitle', 'Speaker: Mary Jones is subtitle');

    // -------------------------------------------------------------------
    // Test 7: Multiline cues
    // -------------------------------------------------------------------
    const vtt7 = `WEBVTT

00:01.000 --> 00:05.000
<v Description>First line of description.
Second line continues.
Third line ends.</v>`;

    result = parseVTT(vtt7);
    TestRunner.assertEqual(result.cues.length, 1, 'Multiline: cue count');
    TestRunner.assert(result.cues[0].text.includes('Second line'), 'Multiline: content preserved');

    // -------------------------------------------------------------------
    // Test 8: Mixed cue types in same block
    // -------------------------------------------------------------------
    const vtt8 = `WEBVTT

00:01.000 --> 00:05.000
<v Description>Visual description here.</v>
<v John>Speaking dialogue.</v>`;

    result = parseVTT(vtt8);
    TestRunner.assertEqual(result.cues.length, 2, 'Mixed block: cue count');
    TestRunner.assertType(result.cues, 0, 'description', 'Mixed block: first is description');
    TestRunner.assertType(result.cues, 1, 'subtitle', 'Mixed block: second is subtitle');

    // -------------------------------------------------------------------
    // Test 9: NOTE blocks
    // -------------------------------------------------------------------
    const vtt9 = `WEBVTT

NOTE This is a comment

00:01.000 --> 00:05.000
<v Description>Content here</v>

NOTE confidence=0.85
High confidence cue`;

    result = parseVTT(vtt9);
    TestRunner.assertEqual(result.cues.length, 1, 'NOTE blocks: cue count');
    TestRunner.assertEqual(result.notes.length, 2, 'NOTE blocks: note count');
    TestRunner.assertEqual(result.notes[1].confidence, 0.85, 'NOTE blocks: confidence parsed');

    // -------------------------------------------------------------------
    // Test 10: Legacy bracket format
    // -------------------------------------------------------------------
    const vtt10 = `WEBVTT

00:01.000 --> 00:05.000
[Description] A person enters the room.

00:05.000 --> 00:10.000
[Curatorial] Historical context about this scene.`;

    result = parseVTT(vtt10);
    TestRunner.assertEqual(result.cues.length, 2, 'Legacy format: cue count');
    TestRunner.assertType(result.cues, 0, 'description', 'Legacy format: [Description]');
    TestRunner.assertType(result.cues, 1, 'curatorial', 'Legacy format: [Curatorial]');

    // -------------------------------------------------------------------
    // Test 11: Time parsing variations
    // -------------------------------------------------------------------
    const vtt11 = `WEBVTT

00:01.000 --> 00:05.000
Short timestamp

00:01:30.500 --> 00:01:35.250
Hour-minute-second format

1:05.100 --> 1:10.200
No leading zero`;

    result = parseVTT(vtt11);
    TestRunner.assertEqual(result.cues.length, 3, 'Time formats: cue count');
    TestRunner.assertEqual(result.cues[0].start, 1.0, 'Time parse: 00:01.000 = 1s');
    TestRunner.assertEqual(result.cues[1].start, 90.5, 'Time parse: 00:01:30.500 = 90.5s');

    // -------------------------------------------------------------------
    // Test 12: Sound keywords detection
    // -------------------------------------------------------------------
    const vtt12 = `WEBVTT

00:01.000 --> 00:02.000
[door slams]

00:02.000 --> 00:03.000
[phone ringing]

00:03.000 --> 00:04.000
[thunder in distance]

00:04.000 --> 00:05.000
[inaudible]`;

    result = parseVTT(vtt12);
    TestRunner.assertEqual(result.cues.length, 4, 'Sound keywords: cue count');
    TestRunner.assertType(result.cues, 0, 'sound', 'Sound keyword: door slams');
    TestRunner.assertType(result.cues, 1, 'sound', 'Sound keyword: phone ringing');
    TestRunner.assertType(result.cues, 2, 'sound', 'Sound keyword: thunder');
    TestRunner.assertType(result.cues, 3, 'sound', 'Sound keyword: inaudible');

    // -------------------------------------------------------------------
    // Test 13: Plain text defaults to subtitle
    // -------------------------------------------------------------------
    const vtt13 = `WEBVTT

00:01.000 --> 00:05.000
Just plain text without any voice span.`;

    result = parseVTT(vtt13);
    TestRunner.assertEqual(result.cues.length, 1, 'Plain text: cue count');
    TestRunner.assertType(result.cues, 0, 'subtitle', 'Plain text: defaults to subtitle');

    // -------------------------------------------------------------------
    // Test 14: Whitespace handling
    // -------------------------------------------------------------------
    const vtt14 = `WEBVTT

00:01.000 --> 00:05.000
<v  Description  >  Lots of spaces  </v>`;

    result = parseVTT(vtt14);
    TestRunner.assertEqual(result.cues.length, 1, 'Whitespace: cue count');
    TestRunner.assertType(result.cues, 0, 'description', 'Whitespace: trimmed correctly');
    TestRunner.assertEqual(result.cues[0].text, 'Lots of spaces', 'Whitespace: content trimmed');

    // -------------------------------------------------------------------
    // Test 15: Hyphenated voice types
    // -------------------------------------------------------------------
    const vtt15 = `WEBVTT

00:01.000 --> 00:02.000
<v visual-description>Hyphenated type</v>

00:02.000 --> 00:03.000
<v extended-description>Extended hyphenated</v>

00:03.000 --> 00:04.000
<v sound-effect>Sound hyphenated</v>`;

    result = parseVTT(vtt15);
    TestRunner.assertEqual(result.cues.length, 3, 'Hyphenated: cue count');
    TestRunner.assertType(result.cues, 0, 'description', 'Hyphenated: visual-description');
    TestRunner.assertType(result.cues, 1, 'curatorial', 'Hyphenated: extended-description');
    TestRunner.assertType(result.cues, 2, 'sound', 'Hyphenated: sound-effect');

    // Report results
    return TestRunner.report();
}

// =============================================================================
// TIME UTILITY TESTS
// =============================================================================

function runTimeTests() {
    console.log('\n🧪 Running Time Utility Tests...\n');
    TestRunner.reset();

    // parseTimeStr tests
    TestRunner.assertEqual(parseTimeStr('00:01.000'), 1.0, 'parseTimeStr: MM:SS.mmm');
    TestRunner.assertEqual(parseTimeStr('01:30.500'), 90.5, 'parseTimeStr: MM:SS.mmm (90.5s)');
    TestRunner.assertEqual(parseTimeStr('00:01:30.500'), 90.5, 'parseTimeStr: HH:MM:SS.mmm');
    TestRunner.assertEqual(parseTimeStr('1:00:00.000'), 3600, 'parseTimeStr: 1 hour');
    TestRunner.assertEqual(parseTimeStr('0:05'), 5.0, 'parseTimeStr: M:SS (no ms)');

    // formatTime tests (if available)
    if (typeof formatTime === 'function') {
        TestRunner.assertEqual(formatTime(90.5), '01:30', 'formatTime: 90.5s = 01:30');
        TestRunner.assertEqual(formatTime(3661), '1:01:01', 'formatTime: 3661s = 1:01:01');
    }

    return TestRunner.report();
}

// =============================================================================
// VOICE TYPE MAP TESTS
// =============================================================================

function runVoiceTypeTests() {
    console.log('\n🧪 Running Voice Type Detection Tests...\n');
    TestRunner.reset();

    // Description aliases (using getVoiceType function)
    const descAliases = ['description', 'desc', 'visual', 'Visual Description',
        'scene', 'Scene Description', 'ad', 'narrator', 'narration'];
    descAliases.forEach(alias => {
        TestRunner.assertEqual(getVoiceType(alias), 'description', `getVoiceType: "${alias}" → description`);
    });

    // Curatorial aliases  
    const curAliases = ['curatorial', 'Curatorial', 'extended', 'Extended Description',
        'archival', 'context', 'historical', 'note'];
    curAliases.forEach(alias => {
        TestRunner.assertEqual(getVoiceType(alias), 'curatorial', `getVoiceType: "${alias}" → curatorial`);
    });

    // Sound aliases
    const soundAliases = ['sound', 'Sound', 'sfx', 'SFX', 'fx', 'effect', 'sound-effect'];
    soundAliases.forEach(alias => {
        TestRunner.assertEqual(getVoiceType(alias), 'sound', `getVoiceType: "${alias}" → sound`);
    });

    // Speaker names return null
    const speakers = ['John Smith', 'Mary Jones', 'Narrator Bob'];
    speakers.forEach(name => {
        TestRunner.assertEqual(getVoiceType(name), null, `getVoiceType: "${name}" → null (speaker)`);
    });

    return TestRunner.report();
}

// =============================================================================
// MAIN TEST RUNNER
// =============================================================================

function runAllTests() {
    console.log('\n' + '🔬'.repeat(30));
    console.log('🔬 open-vtt Test Suite');
    console.log('🔬'.repeat(30) + '\n');

    const results = {
        parser: runParserTests(),
        time: runTimeTests(),
        voiceType: runVoiceTypeTests()
    };

    console.log('\n' + '='.repeat(60));
    console.log('📋 SUMMARY');
    console.log('='.repeat(60));
    console.log(`Parser Tests: ${results.parser ? '✅ PASSED' : '❌ FAILED'}`);
    console.log(`Time Tests: ${results.time ? '✅ PASSED' : '❌ FAILED'}`);
    console.log(`Voice Type Tests: ${results.voiceType ? '✅ PASSED' : '❌ FAILED'}`);

    const allPassed = Object.values(results).every(r => r);
    console.log('\n' + (allPassed ? '✅ ALL TESTS PASSED!' : '❌ SOME TESTS FAILED'));
    console.log('='.repeat(60) + '\n');

    return allPassed;
}

// Export for manual testing - run via console: OpenVTTTests.runAll()
window.OpenVTTTests = {
    runAll: runAllTests,
    runParser: runParserTests,
    runTime: runTimeTests,
    runVoiceType: runVoiceTypeTests
};

