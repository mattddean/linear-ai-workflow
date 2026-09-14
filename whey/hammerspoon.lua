local M = {}

local spaces = require("hs.spaces")

local function readFile(file)
  local handle, err = io.open(file, "r")
  if not handle then
    error(err)
  end

  local value = handle:read("*a")
  handle:close()
  return value
end

local function screenFor(spec)
  if spec == nil or spec == "" or spec == "Main" then
    return hs.screen.mainScreen()
  end

  if spec == "Primary" then
    return hs.screen.primaryScreen()
  end

  if spec == "focused" or spec == "mouse" then
    return hs.mouse.getCurrentScreen() or hs.screen.mainScreen()
  end

  for _, candidate in ipairs(hs.screen.allScreens()) do
    if tostring(candidate:id()) == tostring(spec) then
      return candidate
    end

    if candidate:getUUID() == spec or candidate:name() == spec then
      return candidate
    end
  end

  error("No Hammerspoon screen matched '" .. tostring(spec) .. "'.")
end

local function screenForSpace(spaceId)
  local uuid = spaces.spaceDisplay(spaceId)

  if not uuid then
    return hs.screen.mainScreen()
  end

  for _, candidate in ipairs(hs.screen.allScreens()) do
    if candidate:getUUID() == uuid then
      return candidate
    end
  end

  return hs.screen.mainScreen()
end

local function tableSet(values)
  local output = {}

  for _, value in ipairs(values or {}) do
    output[tonumber(value)] = true
  end

  return output
end

local function spaceExists(spaceId)
  if not spaceId then
    return false
  end

  for _, ids in pairs(spaces.allSpaces() or {}) do
    for _, id in ipairs(ids) do
      if tonumber(id) == tonumber(spaceId) then
        return true
      end
    end
  end

  return false
end

local function firstUserSpaceExcept(excludedSpaceId, preferredScreen)
  local screens = {}

  if preferredScreen then
    table.insert(screens, preferredScreen)
  end

  for _, candidate in ipairs(hs.screen.allScreens()) do
    if not preferredScreen or candidate:id() ~= preferredScreen:id() then
      table.insert(screens, candidate)
    end
  end

  for _, candidate in ipairs(screens) do
    for _, id in ipairs(spaces.spacesForScreen(candidate) or {}) do
      if tonumber(id) ~= tonumber(excludedSpaceId) and spaces.spaceType(id) == "user" then
        return id
      end
    end
  end

  return nil
end

local function gotoSpace(spaceId)
  if not spaceId or not spaceExists(spaceId) then
    error("Native macOS Space does not exist: " .. tostring(spaceId))
  end

  if tonumber(spaces.focusedSpace()) == tonumber(spaceId) then
    return
  end

  local ok, err = spaces.gotoSpace(spaceId)
  if not ok then
    error(err or "Failed to switch native macOS Space.")
  end

  hs.timer.usleep(math.max(spaces.MCwaitTime or 0.5, 0.5) * 1000000)
end

local function windowAppName(win)
  local app = win and win:application()
  return app and app:name() or ""
end

local function windowInfo(win)
  local id = win:id()

  return {
    ["window-id"] = id,
    ["app-name"] = windowAppName(win),
    ["window-title"] = win:title() or "",
    ["space-ids"] = spaces.windowSpaces(id) or {},
  }
end

local function closeWindowId(id)
  local win = hs.window.get(tonumber(id))

  if win then
    win:close()
    return true
  end

  return false
end

local function frameFromSpec(screenFrame, spec)
  return {
    x = screenFrame.x + screenFrame.w * (spec.x or 0),
    y = screenFrame.y + screenFrame.h * (spec.y or 0),
    w = screenFrame.w * (spec.w or 1),
    h = screenFrame.h * (spec.h or 1),
  }
end

local function keyModifiers(values)
  local aliases = {
    alt = "alt",
    cmd = "cmd",
    command = "cmd",
    control = "ctrl",
    ctrl = "ctrl",
    option = "alt",
    shift = "shift",
  }
  local output = {}

  for _, value in ipairs(values or {}) do
    local modifier = aliases[tostring(value)]

    if not modifier then
      error("Unknown key modifier: " .. tostring(value))
    end

    table.insert(output, modifier)
  end

  return output
end

local actions = {}

function actions.check()
  return {
    spacesHaveSeparateSpaces = spaces.screensHaveSeparateSpaces(),
    focusedSpaceId = spaces.focusedSpace(),
  }
end

function actions.ensureSpace(payload)
  local existingSpaceId = tonumber(payload.spaceId)

  if existingSpaceId and spaceExists(existingSpaceId) then
    gotoSpace(existingSpaceId)
    return {
      spaceId = existingSpaceId,
      parkingSpaceId = tonumber(payload.parkingSpaceId) or firstUserSpaceExcept(existingSpaceId, screenForSpace(existingSpaceId)),
    }
  end

  local targetScreen = screenFor(payload.screen)
  local before = tableSet(spaces.spacesForScreen(targetScreen) or {})
  local parkingSpaceId = spaces.focusedSpace()
  local ok, err = spaces.addSpaceToScreen(targetScreen, true)

  if not ok then
    error(err or "Failed to create native macOS Space.")
  end

  local createdSpaceId = nil

  for _ = 1, 20 do
    hs.timer.usleep(250000)

    for _, id in ipairs(spaces.spacesForScreen(targetScreen) or {}) do
      if not before[tonumber(id)] then
        createdSpaceId = id
      end
    end

    if createdSpaceId then
      break
    end
  end

  if not createdSpaceId then
    local ids = spaces.spacesForScreen(targetScreen) or {}
    createdSpaceId = ids[#ids]
  end

  if not createdSpaceId then
    error("Hammerspoon created a Space but could not identify its ID.")
  end

  gotoSpace(createdSpaceId)

  return {
    spaceId = createdSpaceId,
    parkingSpaceId = parkingSpaceId,
  }
end

function actions.gotoSpace(payload)
  gotoSpace(tonumber(payload.spaceId))
  return { spaceId = tonumber(payload.spaceId) }
end

function actions.listWindows()
  local output = {}

  for _, win in ipairs(hs.window.allWindows()) do
    if win:id() then
      table.insert(output, windowInfo(win))
    end
  end

  return output
end

function actions.moveWindowsToSpace(payload)
  local spaceId = tonumber(payload.spaceId)

  if not spaceExists(spaceId) then
    error("Native macOS Space does not exist: " .. tostring(spaceId))
  end

  for _, id in ipairs(payload.windowIds or {}) do
    local ok, err = spaces.moveWindowToSpace(tonumber(id), spaceId, true)

    if not ok then
      error(err or ("Failed to move window " .. tostring(id) .. " to native macOS Space."))
    end
  end

  return { moved = #(payload.windowIds or {}) }
end

function actions.applyLayout(payload)
  local spaceId = tonumber(payload.spaceId)
  local layout = payload.layout or {}
  local groups = payload.groups or {}
  local frame = screenForSpace(spaceId):frame()
  local terminalIds = groups[layout.terminalGroup or "terminal"] or {}
  local appIds = groups[layout.appGroup or "apps"] or {}
  local terminalFrame = layout.frames and layout.frames.terminal
  local appFrames = (layout.frames and layout.frames.apps) or {}
  local focused = false

  gotoSpace(spaceId)

  if terminalFrame then
    for _, id in ipairs(terminalIds) do
      local win = hs.window.get(tonumber(id))

      if win then
        win:setFrame(frameFromSpec(frame, terminalFrame), 0)
        win:raise()
      end
    end
  end

  for _, spec in ipairs(appFrames) do
    for _, id in ipairs(appIds) do
      local win = hs.window.get(tonumber(id))

      if win and windowAppName(win) == spec.app then
        win:setFrame(frameFromSpec(frame, spec), 0)
        win:raise()

        if not focused and spec.app == layout.focusApp then
          win:focus()
          focused = true
        end
      end
    end
  end

  if not focused and appIds[1] then
    local win = hs.window.get(tonumber(appIds[1]))

    if win then
      win:focus()
    end
  end

  return { applied = true }
end

function actions.closeWindows(payload)
  local closed = 0

  for _, id in ipairs(payload.windowIds or {}) do
    if closeWindowId(id) then
      closed = closed + 1
    end
  end

  return { closed = closed }
end

function actions.appShortcut(payload)
  if not payload.app or payload.app == "" then
    error("appShortcut requires an app.")
  end

  if not payload.key or payload.key == "" then
    error("appShortcut requires a key.")
  end

  hs.application.launchOrFocus(payload.app)
  hs.timer.usleep(math.floor((tonumber(payload.delaySeconds) or 0.25) * 1000000))
  hs.eventtap.keyStroke(keyModifiers(payload.modifiers), payload.key, 0)

  return {
    app = payload.app,
    key = payload.key,
  }
end

function actions.stopSpace(payload)
  local spaceId = tonumber(payload.spaceId)

  if not spaceId or not spaceExists(spaceId) then
    return { removed = false, closed = 0 }
  end

  gotoSpace(spaceId)

  local ids = tableSet(payload.windowIds or {})

  for _, id in ipairs(spaces.windowsForSpace(spaceId) or {}) do
    ids[tonumber(id)] = true
  end

  local closed = 0

  -- Destructive: closes all resolvable windows in the isolate Space before
  -- removing it, so the Space does not survive by adopting leftover windows.
  for id, _ in pairs(ids) do
    if closeWindowId(id) then
      closed = closed + 1
    end
  end

  hs.timer.usleep(750000)

  local parkingSpaceId = tonumber(payload.parkingSpaceId)

  if not parkingSpaceId or parkingSpaceId == spaceId or not spaceExists(parkingSpaceId) then
    parkingSpaceId = firstUserSpaceExcept(spaceId, screenForSpace(spaceId))
  end

  if not parkingSpaceId then
    error("No parking Space is available; macOS will not remove the final user Space on a display.")
  end

  gotoSpace(parkingSpaceId)

  local ok, err = spaces.removeSpace(spaceId, true)
  if not ok then
    error(err or "Failed to remove native macOS Space.")
  end

  return {
    removed = true,
    closed = closed,
    parkingSpaceId = parkingSpaceId,
  }
end

local function dispatch(payload)
  local action = actions[payload.action]

  if not action then
    error("Unknown Hammerspoon action: " .. tostring(payload.action))
  end

  return action(payload)
end

function M.main(payloadPath)
  local payload = hs.json.decode(readFile(payloadPath))

  if payload and payload.missionControlWaitSeconds then
    local wait = tonumber(payload.missionControlWaitSeconds)

    if wait and wait > 0 then
      spaces.MCwaitTime = wait
      spaces.setDefaultMCwaitTime(wait)
    end
  end

  local ok, result = pcall(dispatch, payload or {})

  if ok then
    print(hs.json.encode({ ok = true, result = result or {} }))
  else
    print(hs.json.encode({ ok = false, error = tostring(result) }))
  end
end

return M
