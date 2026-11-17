Build a first-person 3D horror game that runs in a web browser. The player is
alone at night inside a three-floor school building, has to find a "fire key"
while a monster hunts them, and escapes through a locked exit.

## Tech
- Three.js with Vite, plain JavaScript, no backend. `npm run dev` starts it.
- Dark, realistic look: real shadows, very low ambient light, light fog, subtle
  film grain. The building's ceiling lights are off or flickering. The player's
  flashlight is the only reliable light.

## Reference material: look at all of it before building anything
- `references/monster.png`: the monster design.
- `references/map/`: 63 photos of the real building, named by floor and place
  (`f1_` = first floor, `f2_`, `f3_`, `stairA_`, `stairB_`). Files with LOCKED
  or OFF_LIMITS in the name show areas the player cannot enter; they are there
  only so you know what is behind a locked door.
- Use the photos for room shapes, proportions, materials and furniture.
- Do NOT copy the real artwork, portraits, posters or signs on the walls.
  Hang generic made-up framed art and blank bulletin boards in those places.
  Ignore any people visible in the photos.
- If the photos and the layout below disagree or something is unclear, ask me
  instead of guessing.

## Shared look of the building
- Floors: polished, slightly cracked tan concrete everywhere in the halls.
- Walls: off-white, with wood baseboards. Doors and door frames are warm brown
  wood; many doors have a narrow window.
- Floors 2 and 3: drop-tile ceilings with rectangular light panels.
- Floor 1: smooth ceiling with grey acoustic panels and round drum pendant
  lights; it is an art gallery, with display cases, pedestals and benches.
- Hallways are roughly 2.5 m wide with ceilings about 3 m high. Estimate
  lengths from the photos (count doors and light panels).

## Map layout
The playable area is the central section of the building: three floors, each
with one long straight hallway. Stairwell A is at one end and stairwell B at
the other. "Left" and "right" below mean walking from A toward B.

Build the map from a data file (rooms, doors, connections, spawn points) so I
can correct positions without touching code.

### Both stairwells
- Concrete steps, black metal railings, black wall handrail, a half-landing
  with two tall windows between each floor (dark outside).
- Stairs continuing up past floor 3 are blocked off and cannot be climbed.
- Every door that leads away from the central section into another wing is
  locked. Trying it plays a rattle sound and shows "Locked."

### Floor 3
- Stairwell A landing: trash bins, fire extinguisher, heavy wooden fire door
  with a push bar opening into the hallway.
- Hallway from A: large portrait frame on the left, big bulletin board on the
  right, classroom and office doors on both sides.
- Left side, in order: the library, then the computer lab.
  - Library: big carpeted room, a full wall of tall bookshelves, wooden
    armchairs and couches, study tables, a front desk. Best hiding room.
  - Computer lab: long carpeted room, computers on desks along both long
    walls, bean bags at the far end. One door only, so it is a dead end.
- Right side, mid-hallway: an elevator. It does not work.
- B end: water bottle station on the right, a door with a hazard-diamond sign
  on the left, then an exit doorway to the stairwell B landing.
- Stairwell B landing: a door straight ahead into another wing. Locked.

### Floor 2
- Stairwell A landing: fire door into the hallway, plus a doorway to another
  wing. Locked.
- Hallway: classroom doors with windows on both sides, bulletin boards, a long
  strip of small framed pictures along the right wall.
- At least four classrooms are enterable: desks, chairs, a teacher's desk,
  cabinets.
- B end: a short side passage with two doors, then the fire door to the
  stairwell B landing. The hallway beyond that landing is another wing. Locked.

### Floor 1
- Stairwells are open here (no fire doors). Each has a small room beside the
  bottom of the stairs.
- Gallery hallway from A: water station and bins on the left, glass display
  cases, mannequins, framed art on both walls, elevator on the right.
- Middle of the floor opens into the lobby and reception:
  - Reception: front desk, grey armchairs, side tables, potted plants.
    THE PLAYER STARTS HERE.
  - Display alcove: an angled bay with arched wooden niches and tall panels.
  - Black leather chairs and log-stump tables where the lobby meets the hall.
  - Black glass double doors under two arches, with an exit sign above. These
    lead to the chapel. Locked; the chapel is dark behind the glass.
  - A glass-walled nook with a wall of living plants and a bench.
  - Steps going down from the lobby to a lower door. Blocked off, off limits.
  - A short hallway with hanging lantern lights and a curved ceiling that
    leads past wood-and-glass doors to the reception restrooms. The restrooms
    are enterable: wooden stall doors, a row of sinks and mirrors.
  - An unlit side corridor off the lobby. Make it a short dead end with
    locked doors.
- Gallery hallway continues to B: white pedestals with sculptures, a wall
  covered in a grid of small framed pictures, and wooden double doors with
  coloured glass at the very end.
- THE EXIT: the wooden double doors with coloured glass at the B end of the
  first-floor gallery. They are locked until the player has the fire key.
  (I may change which door is the exit, so keep it a single setting in the
  map data file.)

## Player
- WASD to move, mouse to look (pointer lock), Shift to sprint.
- Sprint drains a stamina bar that refills when walking or standing still.
- E to interact: pick up the key, open and close doors, enter and leave
  hiding spots.
- Hiding spots, at least 10 across the three floors: restroom stalls, under
  library tables, behind the library front desk, under classroom desks,
  classroom cabinets, behind the reception desk, the plant-wall nook bench.
  The monster cannot find a hidden player unless it saw them enter.
- The player carries a walkie-talkie with a built-in flashlight (F toggles
  the light). The walkie-talkie plays radio static that gets louder and more
  distorted the closer the monster is. Generate the static with the Web Audio
  API. It is the player's only warning system.

## Goal
- Find the fire key, then reach the exit and unlock it to win.
- The fire key is a small red key. It spawns at one random spot each game,
  chosen from at least 10 spawn points spread over all three floors, for
  example: library shelf, library front desk, computer lab desk, a floor 2
  classroom, the floor 2 side passage, restroom sink, display alcove, the
  unlit corridor, a stairwell half-landing, the small room under stairwell B.
  Never spawn it in reception or within sight of the exit.
- Trying the exit without the key shows "Locked. Needs the fire key."

## Monster
Design, from `references/monster.png`: a tall, hunched humanoid with a bald,
pale, eyeless head and a wide grin of bare teeth. It wears a torn, dark
pinstriped suit. Its arms are far too long and end in long pale bone-like
blades that almost drag on the floor. It walks bent forward on bent legs.

Build it in Blender (Blender is installed on this computer):
- Write `tools/build_monster.py` and run Blender in background mode to build
  the model, rig it, and add idle, walk and run animations. Export to
  `public/models/monster.glb`.
- Render a preview image and compare it with the reference photo. Improve the
  script until the silhouette clearly matches, then show me the preview.
- If I later put a ready-made model at `references/monster.glb`, use that
  instead and only rig and animate it.

Behavior (state machine):
- Starts on floor 3, far from the player.
- Patrol: wanders between waypoints on all three floors, using both
  stairwells.
- Investigate: walks to where it last heard sprinting or a door opening.
- Chase: runs when it has line of sight to the player. It is faster than the
  player's walk but slower than the player's sprint.
- Search: after losing the player it checks the area for 10 to 15 seconds,
  then goes back to patrolling.
- A lit flashlight makes the player visible from farther away.
- Closed fire doors block its line of sight; it opens doors slowly and
  loudly.
- Its footsteps are audible and get louder as it gets closer.

## Getting caught
The monster's face fills the screen with a loud scream, then a game over
screen with a Restart button.

## Screens
Title screen with the controls listed, a win screen, a game over screen.

## How to work
Build in this order and make sure the game runs after each step:
1. Player movement in one test room.
2. The full three-floor map from the data file, with basic lighting. Stop
   here and let me walk through it and correct the layout.
3. Doors, locked doors, flashlight, walkie-talkie static, stamina, hiding.
4. Fire key, exit door, win screen.
5. Monster model from Blender.
6. Monster AI, jump scare, game over.
7. Furniture, props, lighting, sound and atmosphere polish.
After each step, run the game and check the browser console for errors.
