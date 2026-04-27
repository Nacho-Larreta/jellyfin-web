import Box from '@mui/material/Box';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu, { type MenuProps } from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Typography from '@mui/material/Typography';
import React, { type FC, type ReactNode } from 'react';

interface ToolbarMenuProps extends MenuProps {
    children: ReactNode;
}

export const TOOLBAR_MENU_ITEM_SX = {
    minHeight: 56,
    px: 2.25,
    py: 1.1,
    gap: 1.65,
    color: '#fff',
    fontFamily: '"Figtree", "Helvetica Neue", Arial, sans-serif',
    '&:hover, &:focus-visible': {
        backgroundColor: 'rgba(255,255,255,0.07)'
    },
    '&.Mui-disabled': {
        opacity: 1
    },
    '& .MuiListItemIcon-root': {
        alignItems: 'center',
        background: 'rgba(255,255,255,0.06)',
        borderRadius: '6px',
        color: '#fff',
        height: 40,
        justifyContent: 'center',
        minWidth: 40,
        width: 40
    },
    '& .MuiListItemText-primary': {
        color: '#fff',
        fontSize: '1rem',
        fontWeight: 700,
        letterSpacing: '-0.01em'
    },
    '& .MuiListItemText-secondary': {
        color: 'rgba(255,255,255,0.46)',
        fontSize: '0.82rem',
        lineHeight: 1.25,
        mt: 0.25
    }
};

const TOOLBAR_MENU_PAPER_SX = {
    background: 'rgba(20,20,20,0.98)',
    border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: '10px',
    boxShadow: '0 22px 70px rgba(0,0,0,0.65), inset 0 1px 0 rgba(255,255,255,0.05)',
    color: '#fff',
    mt: 1.25,
    overflow: 'hidden',
    width: {
        xs: 'calc(100vw - 32px)',
        sm: 360
    }
};

export const ToolbarMenu: FC<ToolbarMenuProps> = ({
    anchorEl,
    children,
    open,
    onClose,
    slotProps,
    ...props
}) => (
    <Menu
        anchorEl={anchorEl}
        anchorOrigin={{
            vertical: 'bottom',
            horizontal: 'right'
        }}
        transformOrigin={{
            vertical: 'top',
            horizontal: 'right'
        }}
        keepMounted
        open={open}
        onClose={onClose}
        slotProps={{
            ...slotProps,
            paper: {
                ...slotProps?.paper,
                sx: TOOLBAR_MENU_PAPER_SX
            },
            list: {
                ...slotProps?.list,
                sx: { p: 0 }
            }
        }}
        {...props}
    >
        {children}
    </Menu>
);

export const ToolbarMenuHeader: FC<{
    children?: ReactNode;
    subtitle?: string;
    title: string;
}> = ({
    children,
    subtitle,
    title
}) => (
    <Box
        sx={{
            background: 'linear-gradient(180deg, rgba(0,164,220,0.10) 0%, rgba(255,255,255,0.02) 100%)',
            borderBottom: '1px solid rgba(255,255,255,0.10)',
            px: 2.25,
            py: 1.8
        }}
    >
        <Typography
            component='p'
            sx={{
                color: '#fff',
                fontSize: '1.04rem',
                fontWeight: 800,
                letterSpacing: '-0.01em',
                lineHeight: 1.15
            }}
        >
            {title}
        </Typography>
        {subtitle && (
            <Typography
                component='p'
                sx={{
                    color: 'rgba(255,255,255,0.48)',
                    fontSize: '0.84rem',
                    mt: 0.5
                }}
            >
                {subtitle}
            </Typography>
        )}
        {children}
    </Box>
);

export const ToolbarEmptyMenuItem: FC<{
    description?: string;
    icon: ReactNode;
    title: string;
}> = ({
    description,
    icon,
    title
}) => (
    <MenuItem
        disabled
        sx={TOOLBAR_MENU_ITEM_SX}
    >
        <ListItemIcon>
            {icon}
        </ListItemIcon>
        <ListItemText
            primary={title}
            secondary={description}
        />
    </MenuItem>
);
