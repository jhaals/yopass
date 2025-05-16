import { faMoon, faSun } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { IconButton, useTheme } from '@mui/material';
import { useColorScheme } from '@mui/material/styles';

export const ModeToggle = () => {
  const { mode, systemMode, setMode } = useColorScheme();
  const { palette } = useTheme();

  const currentMode = (mode == 'system' ? systemMode : mode) ?? 'light';
  const isDarkMode = currentMode == 'dark';
  const nextMode = isDarkMode ? 'light' : 'dark';

  const icon = isDarkMode ? faSun : faMoon;

  return (
    <IconButton onClick={() => setMode(nextMode)}>
      <FontAwesomeIcon icon={icon} color={palette.primary.main} width="24px" />
    </IconButton>
  );
};
